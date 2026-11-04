import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2] / 'src/plugins/proposer-operator/python/retrieve.py'


class RetrievalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('operator_retrieve', WORKER)
        cls.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.worker)

    def documents(self):
        return [dict(id=name, name=name, matchText=name, content='Technique ' + name,
                     example='print(1)\n', sourceReference='reference/' + name,
                     documentDigest='a' * 64, exampleDigest='b' * 64)
                for name in ('core_partition', 'pass_merge', 'loop_invariant_hoisting', 'masked_accumulator')]

    def issue(self, kind, text='issue'):
        return dict(issue_type=kind, issue_summary=text,
                    problematic_code=['x'], evidence=['source'])

    def test_same_type_filter_threshold_boundary_and_max_score_dedup(self):
        issues = [self.issue('core_partition', 'first'), self.issue('core_partition', 'second')]
        # core similarity is exactly threshold; another type scores more but must not win.
        docs = self.documents()
        vectors = [[1.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 0.0]]
        queries = [[0.6, 0.8], [0.8, 0.6]]
        result = self.worker.match_knowledge(issues, docs, vectors, queries, 0.6)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['techniqueId'], 'core_partition')
        self.assertAlmostEqual(result[0]['score'], 0.8)
        self.assertEqual(result[0]['issueIndexes'], [0, 1])
        boundary = self.worker.match_knowledge(issues[:1], docs, vectors, queries[:1], 0.6)
        self.assertAlmostEqual(boundary[0]['score'], 0.6)
        self.assertEqual(self.worker.match_knowledge(issues[:1], docs, vectors, queries[:1], 0.61), [])

    def test_metrics_retrieval_uses_category_query_without_static_issue_filter(self):
        docs = self.documents()
        docs[0]['id'] = 'technique_tiling'
        docs[1]['id'] = 'category_vector'
        vectors = [[1.0, 0.0], [0.0, 1.0], [0.6, 0.8], [0.8, 0.6]]
        result = self.worker.match_metrics(docs, vectors, [1.0, 0.0], 0.6)
        self.assertEqual([hit['techniqueId'] for hit in result], ['technique_tiling', 'masked_accumulator', 'loop_invariant_hoisting'])
        self.assertEqual(len(result), 3)

    def test_invalid_threshold_and_stable_ties(self):
        docs = self.documents()
        kinds = [document['id'] for document in docs]
        issues = [self.issue(kind) for kind in kinds]
        result = self.worker.match_knowledge(issues, docs, [[1.0, 0.0]] * 4, [[1.0, 0.0]] * 4, 0.6)
        self.assertEqual([hit['techniqueId'] for hit in result], sorted(kinds))
        for threshold in (-0.1, 1.1, float('nan'), float('inf'), True):
            with self.subTest(threshold=threshold):
                with self.assertRaises(ValueError):
                    self.worker.match_knowledge(issues, docs, [[1.0, 0.0]] * 4, [[1.0, 0.0]] * 4, threshold)

    def test_invalid_vectors_fail_instead_of_becoming_a_miss(self):
        for query in ([0.0, 0.0], [float('nan'), 1.0], [float('inf'), 1.0], [1.0], []):
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    self.worker.match_knowledge([self.issue('core_partition')], self.documents(), [[1.0, 0.0]] * 4, [query], 0.6)

    def test_context_omits_whole_resources_and_limits_examples(self):
        docs = self.documents()
        matches = [dict(techniqueId=d['id'], score=0.9, issueIndexes=[0], sourceReference=d['sourceReference'],
                        documentDigest=d['documentDigest'], exampleDigest=d['exampleDigest']) for d in docs]
        context, omitted = self.worker.build_context(matches, docs, max_chars=20000, max_examples=3)
        self.assertEqual(context.count('```python'), 3)
        self.assertEqual(len(omitted['examples']), 1)
        context, omitted = self.worker.build_context(matches, docs, max_chars=1, max_examples=3)
        self.assertEqual(context, '')
        self.assertEqual(len(omitted['techniques']), 4)

    def test_query_prompt_and_normalized_cpu_encoding_are_explicit(self):
        class Fake:
            prompts = {'query': 'query instruction'}
            def __init__(self): self.calls = []
            def encode(self, text, **options):
                self.calls.append((text, options))
                return [[1.0, 0.0] for _ in text]
        fake = Fake()
        self.worker.encode_texts(fake, ['document'], as_query=False)
        self.worker.encode_texts(fake, ['question'], as_query=True)
        self.assertIsNone(fake.calls[0][1].get('prompt_name'))
        self.assertEqual(fake.calls[1][1]['prompt_name'], 'query')
        self.assertIs(fake.calls[1][1]['normalize_embeddings'], True)
        fake.prompts = {}
        with self.assertRaises(ValueError): self.worker.encode_texts(fake, ['question'], as_query=True)


class WorkerProtocolTests(unittest.TestCase):
    def test_real_worker_protocol_validates_files_and_runs_without_external_encoder_dependencies(self):
        import hashlib
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('operator_retrieve_protocol', WORKER)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        class Fake:
            prompts = {'query': 'query instruction'}
            def encode(self, texts, **options): return [[1.0, 0.0] for _ in texts]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); model = directory / 'model';model.mkdir()
            (model / 'weights.bin').write_bytes(b'fixed')
            identity_file = directory / 'identity.json'
            identity_file.write_text(json.dumps({'schemaVersion':'rsi.operator-embedding-identity/v1','model':{'id':'test','revision':'fixed'},'encoding':{'queryPromptName':'query','normalizeEmbeddings':True,'device':'cpu','batchSize':32},'files':[{'path':'weights.bin','sha256':hashlib.sha256(b'fixed').hexdigest()}]}))
            resources = WORKER.parent.parent
            request = {'schemaVersion':'rsi.operator-retrieval-request/v1','modelDirectory':str(model),'identityFile':str(identity_file),'embeddingDigest':worker.sha256_file(identity_file),'resourcesDirectory':str(resources),'resourcesDigest':worker.sha256_file(resources/'knowledge/manifest.json'),'device':'cpu','similarityThreshold':0.6,'issues':[{'issue_type':'core_partition','issue_summary':'Independent rows use one program','problematic_code':['x'],'evidence':['visible code']}]}
            with patch.object(worker.importlib.metadata,'version',return_value='test'):
                result = worker.run_request(request,encoder=Fake())
            self.assertEqual(result['matches'][0]['techniqueId'],'core_partition')
            self.assertIn('```python',result['knowledgeContext'])
            self.assertEqual(result['embeddingDigest'],request['embeddingDigest'])
            (model / 'weights.bin').write_bytes(b'changed')
            with self.assertRaises(ValueError):worker.run_request(request,encoder=Fake())


if __name__ == '__main__':
    unittest.main()
