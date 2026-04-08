#!/usr/bin/env python3
"""
Batch embed texts via Google Embedding API through proxy using curl.
Usage: python3 embed-batch.py <input.json>
Input JSON: {"texts":["a","b"],"key":"...","model":"...","proxy":"..."}
Output: JSON array of embeddings
"""
import sys
import json
import subprocess
import tempfile
import os

def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            data = json.load(f)
    else:
        data = json.loads(sys.stdin.read())

    texts = data['texts']
    key = data['key']
    model = data.get('model', 'gemini-embedding-001')
    proxy_url = data.get('proxy', '')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents?key={key}'
    body = json.dumps({
        'requests': [{'model': f'models/{model}', 'content': {'parts': [{'text': t}]}} for t in texts]
    })

    # Write body to temp file
    fd, tmp_path = tempfile.mkstemp(suffix='.json')
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(body)

        # Build curl command
        cmd = ['curl', '-s', '--max-time', '60', '-X', 'POST', url,
               '-H', 'Content-Type: application/json',
               '-d', f'@{tmp_path}',
               '--retry', '2', '--retry-delay', '3']

        if proxy_url:
            from urllib.parse import urlparse
            parsed = urlparse(proxy_url)
            proxy_host = f'http://{parsed.hostname}:{parsed.port}'
            proxy_user = f'{parsed.username}:{parsed.password}'
            cmd.extend(['--proxy', proxy_host, '--proxy-user', proxy_user,
                        '--proxy-insecure'])

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)

        if result.returncode != 0:
            print(json.dumps({'error': f'curl exit {result.returncode}: {result.stderr[:300]}'}))
            sys.exit(1)

        stdout = result.stdout.strip()
        if not stdout:
            print(json.dumps({'error': f'Empty response. stderr: {result.stderr[:300]}'}))
            sys.exit(1)

        # Handle curl --retry concatenating multiple responses — take the last valid JSON
        # Find the last occurrence of {"embeddings" which is our expected response
        last_idx = stdout.rfind('{"embeddings"')
        if last_idx > 0:
            stdout = stdout[last_idx:]
        # Also handle if it starts with error JSON from a failed attempt
        elif stdout.count('{"e') > 1:
            # Multiple JSON objects concatenated — take the last one
            parts = stdout.split('\n{')
            stdout = '{' + parts[-1] if len(parts) > 1 else stdout

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
