#!/usr/bin/env python3
"""
Batch embed texts via Google Embedding API through proxy.
Usage: echo '{"texts":["a","b"],"key":"...","model":"...","proxy":"..."}' | python3 embed-batch.py
Output: JSON array of embeddings
"""
import sys
import json
import urllib.request
import urllib.error

def main():
    data = json.loads(sys.stdin.read())
    texts = data['texts']
    key = data['key']
    model = data.get('model', 'gemini-embedding-001')
    proxy_url = data.get('proxy', '')

    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents?key={key}'
    body = json.dumps({
        'requests': [{'model': f'models/{model}', 'content': {'parts': [{'text': t}]}} for t in texts]
    }).encode()

    if proxy_url:
        proxy_handler = urllib.request.ProxyHandler({
            'http': proxy_url,
            'https': proxy_url,
        })
        opener = urllib.request.build_opener(proxy_handler)
    else:
        opener = urllib.request.build_opener()

    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')

    try:
        resp = opener.open(req, timeout=30)
        result = json.loads(resp.read())
        embeddings = [e['values'] for e in result.get('embeddings', [])]
        print(json.dumps(embeddings))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()[:300]
        print(json.dumps({'error': f'HTTP {e.code}: {error_body}'}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)[:300]}))
        sys.exit(1)

if __name__ == '__main__':
    main()
