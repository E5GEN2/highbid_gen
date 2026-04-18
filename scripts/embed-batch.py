#!/usr/bin/env python3
"""
Batch embed content (text OR image) via Google Embedding API through a proxy,
using curl. Supports `gemini-embedding-001` (text-only) and
`gemini-embedding-2-preview` (multimodal — text + inlineData images).

Usage: python3 embed-batch.py <input.json>
Input JSON:
  {
    "texts": ["title A", "title B"],     # legacy text-only input (maps to parts.text)
    "inputs": [                          # preferred — supports mixed text + image inputs
      { "type": "text", "text": "title A" },
      { "type": "image", "mimeType": "image/jpeg", "data": "<base64>" }
    ],
    "key": "...",
    "model": "gemini-embedding-2-preview",
    "proxy": "http://user:pass@host:port"
  }

Output: JSON array of embedding vectors in input order, or {"error": "..."}.
"""
import sys
import json
import subprocess
import tempfile
import os

def build_part(inp):
    """Convert an input descriptor into a Gemini content.parts entry."""
    t = inp.get('type', 'text')
    if t == 'image':
        return {'inlineData': {'mimeType': inp['mimeType'], 'data': inp['data']}}
    # default: text
    return {'text': inp.get('text', '')}

def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            data = json.load(f)
    else:
        data = json.loads(sys.stdin.read())

    # Build inputs list — prefer new "inputs" array, fall back to legacy "texts"
    if 'inputs' in data and isinstance(data['inputs'], list):
        inputs = data['inputs']
    elif 'texts' in data:
        inputs = [{'type': 'text', 'text': t} for t in data['texts']]
    else:
        print(json.dumps({'error': 'Missing "inputs" or "texts" in payload'}))
        sys.exit(1)

    key = data['key']
    model = data.get('model', 'gemini-embedding-001')
    proxy_url = data.get('proxy', '')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents?key={key}'
    body = json.dumps({
        'requests': [
            {'model': f'models/{model}', 'content': {'parts': [build_part(inp)]}}
            for inp in inputs
        ]
    })

    # Write body to temp file — some requests (image batches) can be many MB,
    # too big for curl's -d or shell arg length.
    fd, tmp_path = tempfile.mkstemp(suffix='.json')
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(body)

        # --max-time 60 so a single batch can't hang a worker for over a minute;
        # retries at the TS layer will still catch transient blips.
        cmd = ['curl', '-s', '--max-time', '60', '-X', 'POST', url,
               '-H', 'Content-Type: application/json',
               '-d', f'@{tmp_path}']

        if proxy_url:
            from urllib.parse import urlparse
            parsed = urlparse(proxy_url)
            proxy_host = f'http://{parsed.hostname}:{parsed.port}'
            proxy_user = f'{parsed.username}:{parsed.password}'
            cmd.extend(['--proxy', proxy_host, '--proxy-user', proxy_user,
                        '--proxy-insecure'])

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

        if result.returncode != 0:
            print(json.dumps({'error': f'curl exit {result.returncode}: {result.stderr[:300]}'}))
            sys.exit(1)

        stdout = result.stdout.strip()
        if not stdout:
            print(json.dumps({'error': f'Empty response. stderr: {result.stderr[:300]}'}))
            sys.exit(1)

        response = json.loads(stdout)

        if 'error' in response:
            err = response['error']
            print(json.dumps({'error': f"API {err.get('code', '?')}: {err.get('message', '')[:200]}"}))
            sys.exit(1)

        embeddings = [e['values'] for e in response.get('embeddings', [])]
        print(json.dumps(embeddings))

    finally:
        os.unlink(tmp_path)

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({'error': str(e), 'traceback': traceback.format_exc()[:500]}))
        sys.exit(1)
