import argparse
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "vllm_ascend_launcher", Path(__file__).parents[1] / "scripts" / "vllm-ascend.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def request(action, **overrides):
    return {
        "action": action,
        "instanceId": "instance-one",
        "experimentId": "experiment-one",
        "parametersDigest": "parameter-hash",
        "parameters": {"max_num_seqs": 16, "max_num_batched_tokens": 2048},
        "memoryUtilization": 0.9,
        "endpoint": {"origin": "http://127.0.0.1:8000", "model": "tuned-model"},
        **overrides,
    }


class LauncherTest(unittest.TestCase):
    def setUp(self):
        parser = argparse.ArgumentParser()
        scheduler = parser.add_argument_group('SchedulerConfig')
        scheduler.add_argument('--max-num-seqs', type=int)
        scheduler.add_argument('--max-num-batched-tokens', type=int)
        scheduler.add_argument('--enable-chunked-prefill', action=argparse.BooleanOptionalAction)
        scheduler.add_argument('--scheduler-reserve', type=int)
        scheduler.add_argument('--scheduler-cls')
        cache = parser.add_argument_group('CacheConfig')
        cache.add_argument('--enable-prefix-caching', action=argparse.BooleanOptionalAction)
        cache.add_argument('--gpu-memory-utilization', type=float)
        model = parser.add_argument_group('ModelConfig')
        model.add_argument('--enforce-eager', action='store_true')
        model.add_argument('--trust-remote-code', action='store_true')
        parser.add_argument('--port', type=int)
        parser.add_argument('--speculative-config')
        self.parser = parser
        self.catalog = launcher.parameter_catalog(parser)
        catalog = patch.object(launcher, 'installed_catalog', return_value=self.catalog)
        catalog.start()
        self.addCleanup(catalog.stop)

    def test_installed_engine_options_define_candidate_space(self):
        catalog = launcher.parameter_catalog(self.parser)
        self.assertIn('scheduler_reserve', catalog)
        self.assertNotIn('trust_remote_code', catalog)
        self.assertNotIn('scheduler_cls', catalog)
        self.assertNotIn('port', catalog)
        flags = launcher.tuning_flags({
            'scheduler_reserve': 7,
            'enable_prefix_caching': False,
            'speculative_config': {'method': 'ngram', 'num_speculative_tokens': 3},
        }, catalog)
        parsed = self.parser.parse_args(flags)
        self.assertEqual(parsed.scheduler_reserve, 7)
        self.assertFalse(parsed.enable_prefix_caching)
        self.assertEqual(json.loads(parsed.speculative_config)['method'], 'ngram')
        with self.assertRaises(launcher.CandidateError):
            launcher.tuning_flags({'speculative_config': {'model': 'unapproved-draft'}}, catalog)

    def test_absent_instance_is_stopped_without_deployment_configuration(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            for action in ("status", "stop"):
                self.assertEqual(launcher.handle(request(action), root), {
                    "status": "stopped", "instanceId": "instance-one",
                })

    @unittest.skipUnless(sys.platform == 'linux', 'requires the Linux launcher')
    def test_discovery_uses_the_serving_python_without_starting_a_model(self):
        with TemporaryDirectory() as temporary:
            module = Path(temporary) / 'vllm/entrypoints/cli/serve.py'
            module.parent.mkdir(parents=True)
            module.write_text('''
from argparse import ArgumentParser as FlexibleArgumentParser

class ServeSubcommand:
    def subparser_init(self, subparsers):
        parser = subparsers.add_parser('serve')
        group = parser.add_argument_group('SchedulerConfig')
        group.add_argument('--installed-scheduler-option', type=int)
        return parser
''')
            command = subprocess.run(
                [sys.executable, '-B', launcher.__file__],
                input='{"action":"describe-parameters"}',
                capture_output=True, text=True, check=True, timeout=10,
                env={**os.environ, 'PYTHONPATH': temporary, 'VLLM_ASCEND_PYTHON': sys.executable},
            )
            options = json.loads(command.stdout)['parameters']
            self.assertEqual(options['installed_scheduler_option']['kind'], 'integer')

    def test_unsupported_parameters_are_rejected_before_starting_a_process(self):
        with TemporaryDirectory() as temporary, patch.object(launcher, "deployment") as deploy:
            root = Path(temporary)
            result = launcher.handle(request("start", parameters={"port": 9000}), root)
            self.assertEqual(result["status"], "startup-failed")
            self.assertEqual(result["parametersDigest"], "parameter-hash")
            self.assertIn("Unsupported", result["reason"])
            deploy.assert_not_called()
            self.assertEqual(launcher.handle(request("stop"), root)["status"], "stopped")

    def test_tuning_flags_preserve_types_and_disallow_shell_or_deployment_arguments(self):
        self.assertEqual(launcher.tuning_flags({
            "max_num_seqs": 16, "enable_chunked_prefill": False, "enforce_eager": True,
        }, self.catalog), ["--no-enable-chunked-prefill", "--enforce-eager", "--max-num-seqs=16"])
        for candidate in ({"max_num_seqs": True}, {"max_num_seqs": "1;touch /tmp/unwanted"}, {"dtype": "float16"}, {"enforce_eager": "true"}):
            with self.subTest(candidate=candidate), self.assertRaises(launcher.CandidateError):
                launcher.tuning_flags(candidate, self.catalog)

    def test_stop_refuses_to_touch_another_instance(self):
        with TemporaryDirectory() as temporary, patch.object(launcher.os, "killpg") as kill:
            root = Path(temporary)
            state = root / "8000"
            state.mkdir()
            (state / "owner.json").write_text(json.dumps({
                "instanceId": "some-other-instance", "experimentId": "experiment-one",
                "parametersDigest": "parameter-hash",
            }))
            with self.assertRaisesRegex(ValueError, "ownership"):
                launcher.handle(request("stop"), root)
            kill.assert_not_called()

    def test_startup_diagnostic_does_not_relay_raw_logs(self):
        with TemporaryDirectory() as temporary:
            log = Path(temporary) / "launch.log"
            log.write_text("private-key=should-not-leak\nRuntimeError: NPU out of memory")
            reason = launcher.startup_reason(log)
            self.assertIn("memory", reason)
            self.assertNotIn("should-not-leak", reason)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux process and socket ownership")
    def test_owned_process_becomes_ready_or_times_out_then_stops(self):
        for ready in (True, False):
            with self.subTest(ready=ready), TemporaryDirectory() as temporary:
                root = Path(temporary)
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                endpoint = {"origin": f"http://127.0.0.1:{port}", "model": "test-model"}
                if ready:
                    script = """
import http.server, sys
class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), Health).serve_forever()
"""
                else:
                    script = "import time; time.sleep(60)"
                argv = [sys.executable, "-c", script, str(port)]
                with (
                    patch.object(launcher, "deployment", return_value=(argv, {"verified": True})),
                    patch.dict(launcher.os.environ, {"VLLM_ASCEND_STARTUP_TIMEOUT_SECONDS": "3" if ready else "1"}),
                ):
                    try:
                        self.assertEqual(launcher.handle(request("start", endpoint=endpoint), root)["status"], "starting")
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            result = launcher.handle(request("status", endpoint=endpoint), root)
                            if result["status"] != "starting":
                                break
                            time.sleep(0.1)
                        self.assertEqual(result["status"], "ready" if ready else "startup-failed")
                        if not ready:
                            self.assertIn("readiness deadline", result["reason"])
                    finally:
                        self.assertEqual(launcher.handle(request("stop", endpoint=endpoint), root)["status"], "stopped")
                self.assertEqual(launcher.handle(request("status", endpoint=endpoint), root)["status"], "stopped")


if __name__ == "__main__":
    unittest.main()
