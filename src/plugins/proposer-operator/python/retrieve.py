"""One-shot CPU retrieval with source-bound local model and knowledge identities."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path, PurePosixPath
import sys

ISSUE_TYPES = {'core_partition', 'pass_merge', 'loop_invariant_hoisting', 'masked_accumulator'}
MAX_BYTES = 2 * 1024 * 1024


def sha256_file(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError('Invalid relative model/resource file path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')):
        raise ValueError('Invalid relative model/resource file path')
    return value


def inventory(directory, exclude=None):
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('Model directory must be an ordinary directory')
    found = []
    def visit(current):
        for entry in sorted(current.iterdir()):
            if exclude is not None and entry.resolve() == exclude.resolve():
                continue
            if entry.is_symlink():
                raise ValueError('Model/resource identity rejects symbolic links')
            if entry.is_dir():
                visit(entry)
            elif entry.is_file():
                found.append({'path': entry.relative_to(directory).as_posix(), 'sha256': sha256_file(entry)})
                if len(found) > 10000:
                    raise ValueError('Model identity file count exceeds 10000')
            else:
                raise ValueError('Model identity requires ordinary files')
    visit(directory)
    return sorted(found, key=lambda item: item['path'])


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError('JSON input must be an ordinary file of at most 2 MiB')
    return json.loads(path.read_text(encoding='utf-8'), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON')))


def verify_identity(directory, identity_file, expected_digest):
    if sha256_file(identity_file) != expected_digest:
        raise ValueError('Embedding identity digest mismatch')
    identity = read_json(identity_file)
    if identity.get('schemaVersion') != 'rsi.operator-embedding-identity/v1':
        raise ValueError('Unsupported embedding identity schema')
    if identity.get('encoding') != {'queryPromptName': 'query', 'normalizeEmbeddings': True, 'device': 'cpu', 'batchSize': 32}:
        raise ValueError('Unsupported embedding encoding identity')
    model = identity.get('model')
    if not isinstance(model, dict) or set(model) != {'id', 'revision'} or any(not isinstance(value, str) or not value.strip() for value in model.values()):
        raise ValueError('Embedding model id and revision are required')
    expected = identity.get('files')
    if not isinstance(expected, list) or not expected:
        raise ValueError('Embedding identity requires model files')
    for file in expected:
        if not isinstance(file, dict) or set(file) != {'path', 'sha256'}:
            raise ValueError('Invalid embedding file identity')
        safe_relative(file['path'])
    if inventory(directory, identity_file) != sorted(expected, key=lambda item: item['path']):
        raise ValueError('Embedding model file identity mismatch')
    return identity


def load_documents(directory, expected_digest, mode="static"):
    manifest_path = directory / 'knowledge/manifest.json'
    if sha256_file(manifest_path) != expected_digest:
        raise ValueError('Knowledge resource identity mismatch')
    manifest = read_json(manifest_path)
    if manifest.get('schemaVersion') != 'rsi.operator-knowledge/v1':
        raise ValueError('Unsupported knowledge schema')
    resources = {}
    for entry in manifest['resources']:
        path = safe_relative(entry['path'])
        file = directory / path
        if file.is_symlink() or not file.is_file() or any(parent.is_symlink() for parent in file.parents if parent != directory and directory in parent.parents):
            raise ValueError('Knowledge resources must be ordinary in-package files')
        if sha256_file(file) != entry['sha256'] or path in resources:
            raise ValueError('Knowledge resource digest mismatch or duplicate path')
        resources[path] = entry['sha256']
    documents = []
    for entry in manifest['metrics' if mode == 'metrics' else 'techniques']:
        document_path = safe_relative(entry['document'])
        example_path = safe_relative(entry['example']) if entry['example'] is not None else None
        if document_path not in resources or (example_path is not None and example_path not in resources):
            raise ValueError('Unlisted knowledge resource')
        document = read_json(directory / document_path)
        if document.get('schemaVersion') != 'rsi.operator-technique/v1' or document.get('id') != entry['id'] or document.get('example') != example_path:
            raise ValueError('Technique identity mismatch')
        for key in ('name', 'matchText', 'content', 'sourceReference'):
            if not isinstance(document.get(key), str) or not document[key].strip():
                raise ValueError('Incomplete knowledge document')
        documents.append({'id': entry['id'], 'name': document['name'], 'matchText': document['matchText'], 'content': document['content'], 'example': (directory / example_path).read_text(encoding='utf-8') if example_path is not None else '', 'sourceReference': document['sourceReference'], 'documentDigest': resources[document_path], 'exampleDigest': resources[example_path] if example_path is not None else None})
    if mode == 'static' and ({document['id'] for document in documents} != ISSUE_TYPES or len(documents) != 4):
        raise ValueError('Static knowledge requires exactly four techniques')
    return documents


def vector(value, dimension=None):
    if hasattr(value, 'tolist'):
        value = value.tolist()
    if not isinstance(value, list) or not value or any(not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(number) for number in value):
        raise ValueError('Embedding vector must contain finite numbers')
    if dimension is not None and len(value) != dimension:
        raise ValueError('Embedding vector dimension mismatch')
    norm = math.sqrt(sum(number * number for number in value))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError('Embedding vector has invalid norm')
    return [number / norm for number in value]


def encode_texts(model, texts, as_query=False):
    if as_query and (not isinstance(getattr(model, 'prompts', None), dict) or not model.prompts.get('query')):
        raise ValueError('Embedding model must support the query prompt')
    encoded = model.encode(texts, normalize_embeddings=True, prompt_name='query' if as_query else None, batch_size=32, show_progress_bar=False)
    if hasattr(encoded, 'tolist'):
        encoded = encoded.tolist()
    if len(encoded) != len(texts):
        raise ValueError('Embedding output coverage mismatch')
    return [vector(value) for value in encoded]


def match_knowledge(issues, documents, document_vectors, query_vectors, threshold):
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError('Similarity threshold must be a finite number from zero to one')
    if len(documents) != len(document_vectors) or len(issues) != len(query_vectors):
        raise ValueError('Embedding output coverage mismatch')
    normalized_documents = [vector(value) for value in document_vectors]
    dimension = len(normalized_documents[0])
    if any(len(value) != dimension for value in normalized_documents):
        raise ValueError('Embedding vector dimension mismatch')
    normalized_queries = [vector(value, dimension) for value in query_vectors]
    hits = {}
    for index, (issue, query) in enumerate(zip(issues, normalized_queries)):
        kind = issue.get('issue_type')
        if kind not in ISSUE_TYPES:
            raise ValueError('Unsupported static issue type')
        for document, target in zip(documents, normalized_documents):
            if document['id'] != kind:
                continue
            score = max(-1.0, min(1.0, sum(a * b for a, b in zip(query, target))))
            if score < threshold:
                continue
            if kind not in hits:
                hits[kind] = {'techniqueId': kind, 'score': score, 'issueIndexes': [], 'sourceReference': document['sourceReference'], 'documentDigest': document['documentDigest'], 'exampleDigest': document['exampleDigest']}
            hits[kind]['score'] = max(score, hits[kind]['score'])
            hits[kind]['issueIndexes'].append(index)
    return sorted(hits.values(), key=lambda hit: (-hit['score'], hit['techniqueId']))


def match_metrics(documents, document_vectors, query_vector, threshold):
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError('Invalid metrics similarity threshold')
    if len(documents) != len(document_vectors) or not documents:
        raise ValueError('Metrics embedding coverage mismatch')
    query = vector(query_vector)
    hits = []
    for document, target in zip(documents, document_vectors):
        target = vector(target, len(query))
        score = max(-1.0, min(1.0, sum(a * b for a, b in zip(query, target))))
        if score >= threshold:
            hits.append({'techniqueId': document['id'], 'score': score, 'issueIndexes': [0], 'sourceReference': document['sourceReference'], 'documentDigest': document['documentDigest'], 'exampleDigest': document['exampleDigest']})
    return sorted(hits, key=lambda hit: (-hit['score'], hit['techniqueId']))[:3]


def build_context(matches, documents, max_chars=20000, max_examples=3):
    by_id = {document['id']: document for document in documents}
    context = ''
    examples = 0
    omitted = {'techniques': [], 'examples': []}
    for match in matches:
        document = by_id[match['techniqueId']]
        text = f"## {document['name']}\n\n{document['content']}\n\nSource: {document['sourceReference']}\n"
        if len(context) + len(text) > max_chars:
            omitted['techniques'].append(document['id'])
            omitted['examples'].append(document['id'])
            continue
        context += text
        sample = f"\n```python\n{document['example']}\n```\n"
        if document['example'] and examples < max_examples and len(context) + len(sample) <= max_chars:
            context += sample
            examples += 1
        else:
            omitted['examples'].append(document['id'])
    return context, omitted


def run_request(request, encoder=None):
    if request.get('schemaVersion') != 'rsi.operator-retrieval-request/v1' or request.get('device') != 'cpu':
        raise ValueError('Expected CPU retrieval request')
    identity = verify_identity(Path(request['modelDirectory']), Path(request['identityFile']), request['embeddingDigest'])
    mode = request.get('mode', 'static')
    if mode not in ('static', 'metrics'):
        raise ValueError('Unsupported retrieval mode')
    documents = load_documents(Path(request['resourcesDirectory']), request['resourcesDigest'], mode)
    if encoder is None:
        from sentence_transformers import SentenceTransformer
        encoder = SentenceTransformer(request['modelDirectory'], device='cpu', trust_remote_code=True, local_files_only=True, tokenizer_kwargs={'padding_side': 'left'})
    document_vectors = encode_texts(encoder, [document['matchText'] for document in documents])
    if mode == 'metrics':
        query = request['query']
        if not isinstance(query, str) or not query.strip():
            raise ValueError('Metrics query is required')
        query_vectors = encode_texts(encoder, [query], as_query=True)
        matches = match_metrics(documents, document_vectors, query_vectors[0], request['similarityThreshold'])
    else:
        issues = request['issues']
        query_vectors = encode_texts(encoder, [f"{issue['issue_type']}: {issue['issue_summary']}" for issue in issues], as_query=True)
        matches = match_knowledge(issues, documents, document_vectors, query_vectors, request['similarityThreshold'])
    context, omitted = build_context(matches, documents)
    runtime = {'python': sys.version.split()[0]}
    for output, package in [('sentenceTransformers', 'sentence-transformers'), ('transformers', 'transformers'), ('torch', 'torch')]:
        runtime[output] = importlib.metadata.version(package)
    return {'schemaVersion': 'rsi.operator-retrieval/v1', 'embeddingDigest': request['embeddingDigest'], 'resourcesDigest': request['resourcesDigest'], 'matches': matches, 'knowledgeContext': context, 'omitted': omitted, 'model': identity['model'], 'runtime': runtime}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--response', required=True)
    args = parser.parse_args()
    try:
        request = read_json(Path(args.request))
        result = run_request(request)
        serialized = json.dumps(result, allow_nan=False)
        if len(serialized.encode('utf-8')) > MAX_BYTES:
            raise ValueError('Retrieval response exceeds 2 MiB')
        Path(args.response).write_text(serialized + '\n', encoding='utf-8')
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
