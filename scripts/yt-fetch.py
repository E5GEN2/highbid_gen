#!/usr/bin/env python3
"""
Fetch from YouTube Data API v3 via xgodo proxy using curl.
Usage: python3 yt-fetch.py <input.json>
Input: {"url":"https://www.googleapis.com/...","proxy":"http://user:pass@host:port"}
Output: JSON response from YouTube API (or {"error":"..."} on failure)
"""
import sys
import json
import subprocess
from urllib.parse import urlparse


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            data = json.load(f)
    else:
        data = json.loads(sys.stdin.read())

    url = data['url']
    proxy_url = data.get('proxy', '')

    cmd = ['curl', '-s', '--max-time', '30', '-X', 'GET', url]

    if proxy_url:
        parsed = urlparse(proxy_url)
        proxy_host = f'http://{parsed.hostname}:{parsed.port}'
        proxy_user = f'{parsed.username}:{parsed.password}'
        cmd.extend(['--proxy', proxy_host, '--proxy-user', proxy_user, '--proxy-insecure'])

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)

    if result.returncode != 0:
        print(json.dumps({'error': f'curl exit {result.returncode}: {result.stderr[:300]}'}))
        sys.exit(1)

    stdout = result.stdout.strip()
    if not stdout:
        print(json.dumps({'error': f'Empty response. stderr: {result.stderr[:300]}'}))
        sys.exit(1)

    # Pass through the raw YouTube API response (already JSON)
    try:
        # Validate it's JSON by parsing then re-emitting
        parsed = json.loads(stdout)
        print(json.dumps(parsed))
    except json.JSONDecodeError:
        print(json.dumps({'error': f'Non-JSON response: {stdout[:300]}'}))
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({'error': str(e), 'traceback': traceback.format_exc()[:500]}))
        sys.exit(1)
