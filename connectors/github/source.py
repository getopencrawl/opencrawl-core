"""OpenCrawl GitHub source for operator-owned Airbyte deployments.

Reads the authorized repository-ID set within a GitHub App installation:
  - git (one clone per repository per sync, no API quota): commits with their full diffs,
    files at the default branch's head with their contents, branches, tags;
  - GraphQL: pull requests with reviews, changed files and commits; discussions with comments;
  - REST: issues, issue and pull request comments, review comments, commit comments, releases.

Incremental state is per repository: the ref tips already read (commits), the head whose files
were read (files), and the newest `updated_at` seen (API streams). Records are written in the
order they are read, and each stream's state is emitted only after a repository's records for
that stream, so a failed sync resumes without gaps.
"""
import base64, json, logging, os, queue, re, shutil, subprocess, sys, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import jwt
import requests
from airbyte_cdk.entrypoint import launch
from airbyte_cdk.models import (AirbyteCatalog, AirbyteConnectionStatus, AirbyteMessage, AirbyteRecordMessage, AirbyteStateBlob,
    AirbyteStateMessage, AirbyteStateStats, AirbyteStateType, AirbyteStream, AirbyteStreamState, AirbyteStreamStatus,
    AirbyteStreamStatusTraceMessage, AirbyteTraceMessage, ConnectorSpecification, Status, StreamDescriptor, SyncMode, TraceType, Type)
from airbyte_cdk.sources.source import Source

API = 'https://api.github.com'
EPOCH = '2000-01-01T00:00:00Z'
# Pull requests and discussions are read newest first and stop at the previous sync's cursor;
# the lookback covers clock skew and edits that land while a sync runs.
LOOKBACK = timedelta(minutes=10)

SPEC = {
    'documentationUrl': 'https://docs.github.com/en/apps',
    'connectionSpecification': {
        '$schema': 'http://json-schema.org/draft-07/schema#', 'title': 'OpenCrawl GitHub', 'type': 'object', 'additionalProperties': True,
        'required': [],
        'properties': {
            'app_id': {'type': 'string', 'title': 'GitHub App ID', 'order': 0},
            'private_key': {'type': 'string', 'title': 'GitHub App private key (PEM)', 'airbyte_secret': True, 'multiline': True, 'order': 1},
            'installation_id': {'type': 'string', 'title': 'Installation ID', 'order': 2},
            'access_token': {'type': 'string', 'title': 'Access token (testing only; instead of the app)', 'airbyte_secret': True, 'order': 3},
            'repositories': {'type': 'array', 'items': {'type': 'string'}, 'title': 'Repositories (owner/name); default: every repository the installation can see', 'order': 4},
            'repository_ids': {'type': 'array', 'items': {'type': 'integer'}, 'minItems': 1, 'title': 'Authorized repository IDs'},
            'start_date': {'type': 'string', 'title': 'Read activity updated after', 'default': EPOCH, 'order': 5},
            'max_file_bytes': {'type': 'integer', 'title': 'Largest file whose content is imported', 'default': 1048576, 'order': 6},
            'max_patch_bytes': {'type': 'integer', 'title': 'Largest diff imported per commit', 'default': 4194304, 'order': 7},
            'num_workers': {'type': 'integer', 'title': 'Repositories read at once', 'default': 4, 'minimum': 1, 'maximum': 16, 'order': 8},
            'api_url': {'type': 'string', 'title': 'API URL', 'default': API, 'order': 9},
        },
    },
}

def _schema(**props):
    return {'$schema': 'http://json-schema.org/draft-07/schema#', 'type': 'object', 'additionalProperties': True,
            'properties': {'repository': {'type': 'string'}, **{k: {'type': ['null', v]} for k, v in props.items()}}}

# name: (primary key, cursor field or None, schema)
STREAMS = {
    'repositories': (['id'], None, _schema(id='integer', full_name='string', private='boolean', default_branch='string', updated_at='string')),
    'branches': (['repository', 'name'], None, _schema(name='string', sha='string', default='boolean')),
    'tags': (['repository', 'name'], None, _schema(name='string', sha='string', message='string')),
    'commits': (['repository', 'sha'], ['committer_date'], _schema(sha='string', message='string', committer_date='string', files='array')),
    'files': (['repository', 'path', 'commit_sha'], ['commit_sha'], _schema(path='string', content='string', commit_sha='string', deleted='boolean')),
    'pull_requests': (['repository', 'number'], ['updated_at'], _schema(number='integer', title='string', body='string', updated_at='string', reviews='array', files='array')),
    'issues': (['repository', 'number'], ['updated_at'], _schema(number='integer', title='string', body='string', updated_at='string')),
    'issue_comments': (['repository', 'id'], ['updated_at'], _schema(id='integer', body='string', updated_at='string')),
    'review_comments': (['repository', 'id'], ['updated_at'], _schema(id='integer', body='string', updated_at='string')),
    'commit_comments': (['repository', 'id'], ['updated_at'], _schema(id='integer', body='string', updated_at='string')),
    'discussions': (['repository', 'number'], ['updated_at'], _schema(number='integer', title='string', body='string', updated_at='string', comments='array')),
    'releases': (['repository', 'id'], None, _schema(id='integer', tag_name='string', body='string')),
}
GIT_STREAMS = {'branches', 'tags', 'commits', 'files'}

def now_ms():
    return int(time.time() * 1000)

def iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def parse(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00'))


class GitHub:
    """GitHub REST and GraphQL with an installation token, waiting out rate limits instead of failing."""

    def __init__(self, config, log):
        self.config, self.log = config, log
        self.api = (config.get('api_url') or API).rstrip('/')
        self.session = requests.Session()
        self.session.headers.update({'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCrawl'})
        self._token, self._expires, self._lock = None, 0, threading.Lock()

    def token(self):
        if self.config.get('access_token') or not self.config.get('app_id'):
            return self.config.get('access_token')  # None: anonymous, public repositories only (testing)
        with self._lock:
            if self._token and time.time() < self._expires - 600:
                return self._token
            now = int(time.time())
            assertion = jwt.encode({'iat': now - 60, 'exp': now + 540, 'iss': str(self.config['app_id'])}, self.config['private_key'], algorithm='RS256')
            res = self.session.post(f"{self.api}/app/installations/{self.config['installation_id']}/access_tokens",
                                    headers={'Authorization': f'Bearer {assertion}'}, timeout=30)
            if res.status_code in (401, 403, 404):
                raise ConfigError(f'GitHub refused the app installation ({res.status_code}). Reconnect GitHub.')
            res.raise_for_status()
            body = res.json()
            self._token, self._expires = body['token'], parse(body['expires_at']).timestamp()
            return self._token

    def request(self, method, url, **kwargs):
        url = url if url.startswith('http') else self.api + url
        for attempt in range(12):
            try:
                token = self.token()
                res = self.session.request(method, url, headers={**({'Authorization': f'Bearer {token}'} if token else {}), **kwargs.get('headers', {})},
                                           timeout=120, **{k: v for k, v in kwargs.items() if k != 'headers'})
            except requests.RequestException as error:
                self.log.warning(f'GitHub request failed ({error.__class__.__name__}); retrying')
                time.sleep(min(60, 2 ** attempt))
                continue
            wait = self._wait(res)
            if wait is not None:
                self.log.info(f'GitHub rate limit: waiting {int(wait)}s')
                time.sleep(wait)
                continue
            if res.status_code >= 500:
                time.sleep(min(60, 2 ** attempt))
                continue
            return res
        raise RuntimeError(f'GitHub kept failing: {method} {url.split("?")[0]}')

    @staticmethod
    def _wait(res):
        """Seconds to wait before retrying, or None. Primary and secondary limits both come as 403 or 429."""
        if res.status_code not in (403, 429):
            return None
        if res.headers.get('retry-after'):
            return int(res.headers['retry-after']) + 1
        if res.headers.get('x-ratelimit-remaining') == '0' and res.headers.get('x-ratelimit-reset'):
            return max(1, int(res.headers['x-ratelimit-reset']) - time.time() + 2)
        if 'rate limit' in res.text.lower():
            return 60
        return None

    def get(self, path, params=None):
        res = self.request('GET', path, params=params)
        res.raise_for_status()
        return res.json()

    def pages(self, path, params=None, key=None):
        """Every item of a paginated REST list, following Link headers."""
        url, params = path, {'per_page': 100, **(params or {})}
        seen = set()
        while url:
            if url in seen or len(seen) >= 10000:
                raise RuntimeError('GitHub REST pagination did not complete')
            seen.add(url)
            res = self.request('GET', url, params=params)
            res.raise_for_status()
            body = res.json()
            items = body.get(key) if key and isinstance(body, dict) else body if not key else None
            if not isinstance(items, list):
                raise RuntimeError('GitHub REST returned an incomplete list')
            yield from items
            url, params = res.links.get('next', {}).get('url'), None

    def graphql(self, query, variables):
        for size in (variables.get('first'), 10, 5, 2, 1):
            if not size:
                continue
            res = self.request('POST', '/graphql', json={'query': query, 'variables': {**variables, 'first': size}})
            if res.status_code in (502, 504):
                continue  # The query was too expensive to finish; ask for fewer nodes.
            res.raise_for_status()
            body = res.json()
            if body.get('errors'):
                if any(e.get('type') == 'RATE_LIMITED' for e in body['errors']):
                    time.sleep(60)
                    continue
                # Partial data must not advance a stream cursor past omitted nodes.
                raise RuntimeError('GitHub GraphQL error: ' + '; '.join(e.get('message', '') for e in body['errors'])[:500])
            return body.get('data') or {}
        raise RuntimeError('GitHub GraphQL kept timing out')


class ConfigError(Exception):
    pass


class Git:
    """A throwaway mirror clone authenticated with the current installation token."""

    def __init__(self, github, full_name, root, log):
        self.github, self.full_name, self.log = github, full_name, log
        self.dir = os.path.join(root, full_name.replace('/', '__') + '.git')

    def _auth(self):
        token = self.github.token()
        if not token:
            return []
        basic = base64.b64encode(f'x-access-token:{token}'.encode()).decode()
        return ['-c', f'http.extraHeader=Authorization: Basic {basic}']

    def run(self, *args, input=None, check=True):
        res = subprocess.run(['git', *self._auth(), '-C', self.dir, *args], input=input, capture_output=True, timeout=3600)
        if check and res.returncode:
            raise RuntimeError(f'git {args[0]} failed for {self.full_name}: {res.stderr.decode(errors="replace")[-500:]}')
        return res.stdout

    def clone(self, base='https://github.com'):
        url = f'{base}/{self.full_name}.git'
        res = subprocess.run(['git', *self._auth(), 'clone', '--quiet', '--mirror', url, self.dir], capture_output=True, timeout=7200)
        if res.returncode:
            raise RuntimeError(f'git clone failed for {self.full_name}: {res.stderr.decode(errors="replace")[-500:]}')

    def refs(self, prefix):
        fmt = '%(refname:strip=2)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(contents)%01'
        out = self.run('for-each-ref', f'--format={fmt}', prefix).decode(errors='replace')
        for entry in filter(None, (e.strip('\n') for e in out.split('\x01'))):
            name, sha, peeled, kind, contents = entry.split('\x00', 4)
            yield {'name': name, 'sha': peeled or sha, 'object_sha': sha, 'annotated': kind == 'tag', 'message': contents if kind == 'tag' else None}

    def exists(self, sha):
        return bool(sha) and subprocess.run(['git', '-C', self.dir, 'cat-file', '-e', f'{sha}^{{commit}}'], capture_output=True).returncode == 0

    def new_commits(self, seen_tips, since):
        """Commits on any ref not reachable from a tip read last time, oldest first."""
        known = [sha for sha in seen_tips if self.exists(sha)]
        args = ['rev-list', '--all', '--reverse', '--topo-order']
        if not known and since:
            args.append(f'--since={since}')
        args += ['--not', *known] if known else []
        return self.run(*args).decode().split()

    def commit(self, sha, max_patch):
        meta = self.run('show', '-s', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', sha).decode(errors='replace')
        sha, tree, parents, an, ae, ad, cn, ce, cd, message = meta.split('\x00', 9)
        parents = parents.split()
        base = parents[:1] if parents else ['--root']
        # Merge commits are compared with their first parent, as GitHub shows them.
        numstat = self.run('diff-tree', '-r', '-M', '-z', '--numstat', '--no-commit-id', *base, sha).decode(errors='replace')
        files = self._numstat(numstat)
        patch = self.run('diff-tree', '-r', '-M', '-p', '--no-commit-id', '--no-color', *base, sha)
        truncated = len(patch) > max_patch
        for path, chunk in self._split_patch(patch[:max_patch].decode(errors='replace')):
            if path in files:
                files[path]['patch'] = chunk
        return {'sha': sha, 'tree': tree, 'parents': parents, 'message': message.rstrip('\n'),
                'author_name': an, 'author_email': ae, 'author_date': iso(parse(ad)), 'committer_name': cn, 'committer_email': ce, 'committer_date': iso(parse(cd)),
                'additions': sum(f['additions'] or 0 for f in files.values()), 'deletions': sum(f['deletions'] or 0 for f in files.values()),
                'files': list(files.values()), 'patch_truncated': truncated}

    @staticmethod
    def _numstat(out):
        files, parts, i = {}, out.split('\x00'), 0
        while i < len(parts) - 1:
            stat = parts[i]
            if not stat:
                i += 1
                continue
            added, deleted, path = stat.split('\t', 2)
            previous = None
            if path == '':  # rename or copy: the next two fields are the old and new paths
                previous, path = parts[i + 1], parts[i + 2]
                i += 3
            else:
                i += 1
            binary = added == '-'
            files[path] = {'path': path, 'previous_path': previous, 'additions': None if binary else int(added),
                           'deletions': None if binary else int(deleted), 'binary': binary, 'patch': None}
        return files

    @staticmethod
    def _split_patch(text):
        for chunk in re.split(r'(?m)^(?=diff --git )', text):
            if not chunk.startswith('diff --git '):
                continue
            match = re.search(r'(?m)^\+\+\+ b/(.*)$', chunk) or re.search(r'(?m)^rename to (.*)$', chunk) or re.search(r'(?m)^--- a/(.*)$', chunk)
            if match:
                yield match.group(1), chunk
            else:
                head = re.match(r'diff --git a/(.*?) b/(.*)$', chunk.splitlines()[0])
                if head:
                    yield head.group(2), chunk

    def tree(self, sha):
        """(mode, type, blob sha, size, path) for every entry at a commit."""
        out = self.run('ls-tree', '-r', '-l', '-z', sha).decode(errors='replace')
        for entry in filter(None, out.split('\x00')):
            info, path = entry.split('\t', 1)
            mode, kind, blob, size = info.split()
            yield mode, kind, blob, None if size == '-' else int(size), path

    def changed_paths(self, old, new):
        out = self.run('diff-tree', '-r', '--no-renames', '-z', '--name-status', old, new).decode(errors='replace')
        parts = [p for p in out.split('\x00') if p != '']
        return {parts[i + 1]: parts[i] for i in range(0, len(parts) - 1, 2)}

    def blobs(self, shas):
        """Contents of blobs by sha, through one cat-file process."""
        proc = subprocess.Popen(['git', '-C', self.dir, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            for sha in shas:
                proc.stdin.write(sha.encode() + b'\n')
                proc.stdin.flush()
                header = proc.stdout.readline().split()
                if len(header) < 3:
                    yield sha, None
                    continue
                data = proc.stdout.read(int(header[2]))
                proc.stdout.read(1)
                yield sha, data
        finally:
            proc.stdin.close()
            proc.stdout.close()
            proc.wait()


PR_QUERY = '''query($owner:String!,$name:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{
id databaseId number title body url state isDraft locked createdAt updatedAt closedAt mergedAt merged mergeable reviewDecision additions deletions changedFiles
author{login} mergedBy{login} baseRefName headRefName baseRefOid headRefOid headRepository{nameWithOwner} mergeCommit{oid} milestone{title number}
labels(first:100){nodes{name}} assignees(first:100){nodes{login}}
reviewRequests(first:100){nodes{requestedReviewer{... on User{login} ... on Team{slug} ... on Bot{login}}}}
closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}}}
reviews(first:100){totalCount nodes{id databaseId author{login} state body submittedAt updatedAt url commit{oid}}}
files(first:100){totalCount nodes{path additions deletions changeType}}
commits(first:100){totalCount nodes{commit{oid}}}}}}}'''

DISCUSSION_QUERY = '''query($owner:String!,$name:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){hasDiscussionsEnabled discussions(first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{
id number title body url createdAt updatedAt closed closedAt locked author{login} category{name} answer{id} labels(first:50){nodes{name}}
comments(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt isAnswer author{login}
replies(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt author{login}}}}}}}}}'''

DISCUSSION_COMMENTS_QUERY = '''query($id:ID!,$first:Int!,$after:String){node(id:$id){... on Discussion{
comments(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt isAnswer author{login}
replies(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt author{login}}}}}}}}'''
DISCUSSION_REPLIES_QUERY = '''query($id:ID!,$first:Int!,$after:String){node(id:$id){... on DiscussionComment{
replies(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt author{login}}}}}}'''


class Reader:
    """Everything one repository yields: (stream, record) and ('$state', stream, repository, value)."""

    def __init__(self, github, config, repo, state, selected, root, log):
        self.github, self.config, self.repo, self.state, self.selected, self.root, self.log = github, config, repo, state, selected, root, log
        self.name = repo['full_name']
        self.since = config.get('start_date') or EPOCH

    def cursor(self, stream):
        return (self.state.get(stream) or {}).get(self.name) or {}

    def run(self):
        yield 'repositories', self.repo
        if self.selected & GIT_STREAMS and self.repo.get('size', 1) is not None:
            yield from self.git()
        for stream, method in [('pull_requests', self.pull_requests), ('issues', self.issues), ('issue_comments', self.issue_comments),
                               ('review_comments', self.review_comments), ('commit_comments', self.commit_comments),
                               ('discussions', self.discussions), ('releases', self.releases)]:
            if stream in self.selected:
                yield from method()

    def record(self, data):
        return {'repository': self.name, **data}

    def git(self):
        git = Git(self.github, self.name, self.root, self.log)
        try:
            git.clone()
            branches = list(git.refs('refs/heads'))
            tags = list(git.refs('refs/tags'))
            default = self.repo.get('default_branch')
            if 'branches' in self.selected:
                for b in branches:
                    yield 'branches', self.record({'name': b['name'], 'sha': b['sha'], 'default': b['name'] == default})
            if 'tags' in self.selected:
                for t in tags:
                    yield 'tags', self.record({'name': t['name'], 'sha': t['sha'], 'object_sha': t['object_sha'], 'annotated': t['annotated'], 'message': t['message']})
            # Every ref the clone has, pull request heads (refs/pull/*) included, so commits that only
            # exist on a pull request are read once too.
            tips = sorted({r['sha'] for r in git.refs('refs/')})
            if 'commits' in self.selected:
                seen = self.cursor('commits').get('tips') or []
                latest = self.cursor('commits').get('committer_date')
                for sha in git.new_commits(seen, None if seen else self.since):
                    commit = git.commit(sha, self.config.get('max_patch_bytes') or 4194304)
                    latest = max(latest or '', commit['committer_date'])
                    yield 'commits', self.record(commit)
                yield '$state', 'commits', self.name, {'tips': tips, 'committer_date': latest}
            if 'files' in self.selected:
                yield from self.files(git, {b['name']: b['sha'] for b in branches}.get(default))
        finally:
            shutil.rmtree(git.dir, ignore_errors=True)

    def files(self, git, head):
        if not head:
            return
        previous = self.cursor('files').get('commit_sha')
        if previous == head:
            return
        limit = self.config.get('max_file_bytes') or 1048576
        entries = {path: (mode, kind, blob, size) for mode, kind, blob, size, path in git.tree(head)}
        if previous and git.exists(previous):
            changes = git.changed_paths(previous, head)
            paths = [p for p in changes if p in entries]
            deleted = [p for p, status in changes.items() if status == 'D' or p not in entries]
        else:
            paths, deleted = list(entries), []
        branch = self.repo.get('default_branch')
        for path in deleted:
            yield 'files', self.record({'path': path, 'branch': branch, 'commit_sha': head, 'deleted': True, 'content': None})
        wanted = [entries[p][2] for p in paths if entries[p][1] == 'blob' and (entries[p][3] or 0) <= limit]
        contents = dict(git.blobs(dict.fromkeys(wanted)))
        for path in paths:
            mode, kind, blob, size = entries[path]
            data = contents.get(blob) if kind == 'blob' else None
            text, binary = None, False
            if data is not None:
                binary = b'\x00' in data[:8000]
                if not binary:
                    try:
                        text = data.decode('utf-8')
                    except UnicodeDecodeError:
                        binary = True
            yield 'files', self.record({'path': path, 'branch': branch, 'commit_sha': head, 'blob_sha': blob, 'mode': mode, 'type': kind,
                                        'size': size, 'binary': binary, 'too_large': kind == 'blob' and (size or 0) > limit,
                                        'deleted': False, 'content': text})
        yield '$state', 'files', self.name, {'commit_sha': head}

    def _newest_first(self, stream, query, key, shape):
        """GraphQL lists ordered by updatedAt, newest first, stopping at the last sync's cursor."""
        owner, name = self.name.split('/', 1)
        stop = self.cursor(stream).get('updated_at')
        stop = iso(parse(stop) - LOOKBACK) if stop else self.since
        newest, after, seen = None, None, set()
        while True:
            data = self.github.graphql(query, {'owner': owner, 'name': name, 'first': 25, 'after': after})
            page = (data.get('repository') or {}).get(key)
            if not isinstance(page, dict) or not isinstance(page.get('nodes'), list) or not isinstance(page.get('pageInfo', {}).get('hasNextPage'), bool):
                raise RuntimeError('GitHub GraphQL returned an incomplete list')
            reached_stop = False
            for node in page['nodes']:
                if node['updatedAt'] < stop:
                    reached_stop = True
                    break
                newest = max(newest or '', node['updatedAt'])
                yield stream, self.record(shape(node))
            info = page['pageInfo']
            if reached_stop or not info['hasNextPage']:
                break
            after = info.get('endCursor')
            if not after or after in seen or len(seen) >= 10000:
                raise RuntimeError('GitHub GraphQL pagination did not advance')
            seen.add(after)
        yield '$state', stream, self.name, {'updated_at': newest or self.cursor(stream).get('updated_at')}

    def _discussion_nodes(self, parent_id, page, replies=False):
        """Fully materialize one nested connection before acknowledging its discussion."""
        field = 'replies' if replies else 'comments'
        query = DISCUSSION_REPLIES_QUERY if replies else DISCUSSION_COMMENTS_QUERY
        nodes, identities, cursors, expected = [], set(), set(), None
        while True:
            if not isinstance(page, dict) or not isinstance(page.get('nodes'), list) or type(page.get('totalCount')) is not int or page['totalCount'] < 0:
                raise RuntimeError('GitHub discussion connection is incomplete')
            expected = page['totalCount'] if expected is None else expected
            if page['totalCount'] != expected:
                raise RuntimeError('GitHub discussion changed while reading; retry')
            for node in page['nodes']:
                identity = node.get('id') if isinstance(node, dict) else None
                if not identity or identity in identities:
                    raise RuntimeError('GitHub discussion contains missing or duplicate nodes')
                identities.add(identity)
                nodes.append(node)
            info = page.get('pageInfo') or {}
            if not isinstance(info.get('hasNextPage'), bool):
                raise RuntimeError('GitHub discussion pagination is incomplete')
            if not info['hasNextPage']:
                if len(nodes) != expected:
                    raise RuntimeError('GitHub discussion coverage is incomplete')
                return nodes
            after = info.get('endCursor')
            if not after or after in cursors or len(cursors) >= 1000 or len(nodes) >= expected:
                raise RuntimeError('GitHub discussion pagination did not advance')
            cursors.add(after)
            data = self.github.graphql(query, {'id': parent_id, 'first': 100, 'after': after})
            page = (data.get('node') or {}).get(field)

    def pull_requests(self):
        def shape(pr):
            number = pr['number']
            reviews = pr.pop('reviews')
            files = pr.pop('files')
            commits = pr.pop('commits')
            # Rarely more than 100: read the rest over REST.
            pr['reviews'] = reviews['nodes'] if reviews['totalCount'] <= len(reviews['nodes']) else \
                list(self.github.pages(f'/repos/{self.name}/pulls/{number}/reviews'))
            pr['files'] = files['nodes'] if files['totalCount'] <= len(files['nodes']) else \
                [{'path': f['filename'], 'additions': f['additions'], 'deletions': f['deletions'], 'changeType': f['status'].upper(), 'patch': f.get('patch')}
                 for f in self.github.pages(f'/repos/{self.name}/pulls/{number}/files')]
            pr['commit_shas'] = [c['commit']['oid'] for c in commits['nodes']] if commits['totalCount'] <= len(commits['nodes']) else \
                [c['sha'] for c in self.github.pages(f'/repos/{self.name}/pulls/{number}/commits')]
            for field in ('labels', 'assignees', 'reviewRequests', 'closingIssuesReferences'):
                pr[field] = (pr.get(field) or {}).get('nodes') or []
            pr['updated_at'] = pr['updatedAt']
            return pr
        yield from self._newest_first('pull_requests', PR_QUERY, 'pullRequests', shape)

    def discussions(self):
        def shape(d):
            d['labels'] = (d.get('labels') or {}).get('nodes') or []
            d['comments'] = self._discussion_nodes(d['id'], d.get('comments'))
            for c in d['comments']:
                c['replies'] = self._discussion_nodes(c['id'], c.get('replies'), replies=True)
            d['updated_at'] = d['updatedAt']
            return d
        if self.repo.get('has_discussions') is False:
            return
        yield from self._newest_first('discussions', DISCUSSION_QUERY, 'discussions', shape)

    def _since(self, stream, path, params=None, skip=None):
        """REST lists that take `since` and sort by updated, oldest first."""
        since = self.cursor(stream).get('updated_at') or self.since
        newest = since
        for item in self.github.pages(path, {'since': since, 'sort': 'updated', 'direction': 'asc', **(params or {})}):
            if skip and skip(item):
                continue
            newest = max(newest, item.get('updated_at') or newest)
            yield stream, self.record(item)
        yield '$state', stream, self.name, {'updated_at': newest}

    def issues(self):
        # The issues list includes pull requests; those come from pull_requests.
        yield from self._since('issues', f'/repos/{self.name}/issues', {'state': 'all'}, skip=lambda i: 'pull_request' in i)

    def issue_comments(self):
        yield from self._since('issue_comments', f'/repos/{self.name}/issues/comments')

    def review_comments(self):
        yield from self._since('review_comments', f'/repos/{self.name}/pulls/comments')

    def commit_comments(self):
        # No `since` on this list: read it all and keep what changed.
        since = self.cursor('commit_comments').get('updated_at') or self.since
        newest = since
        for item in self.github.pages(f'/repos/{self.name}/comments'):
            if (item.get('updated_at') or '') >= since:
                newest = max(newest, item['updated_at'])
                yield 'commit_comments', self.record(item)
        yield '$state', 'commit_comments', self.name, {'updated_at': newest}

    def releases(self):
        for item in self.github.pages(f'/repos/{self.name}/releases'):
            yield 'releases', self.record(item)


class SourceOpenCrawlGitHub(Source):
    def spec(self, logger):
        return ConnectorSpecification.from_dict(SPEC) if hasattr(ConnectorSpecification, 'from_dict') else ConnectorSpecification(**SPEC)

    def check(self, logger, config):
        try:
            github = GitHub(config, logger)
            repos = list(self.repositories(github, config))
            return AirbyteConnectionStatus(status=Status.SUCCEEDED, message=f'{len(repos)} repositories')
        except Exception as error:  # noqa: BLE001 - reported to the user
            return AirbyteConnectionStatus(status=Status.FAILED, message=str(error)[:500])

    def discover(self, logger, config):
        streams = []
        for name, (key, cursor, schema) in STREAMS.items():
            modes = [SyncMode.full_refresh, SyncMode.incremental] if cursor else [SyncMode.full_refresh]
            streams.append(AirbyteStream(name=name, json_schema=schema, supported_sync_modes=modes, source_defined_primary_key=[[k] for k in key],
                                         source_defined_cursor=bool(cursor), default_cursor_field=cursor))
        return AirbyteCatalog(streams=streams)

    @staticmethod
    def repositories(github, config):
        wanted = {r.lower() for r in config.get('repositories') or []}
        allowed = config.get('repository_ids')
        if allowed is not None and (not isinstance(allowed, list) or not allowed or any(type(r) is not int or r <= 0 for r in allowed)):
            raise ConfigError('Authorized repository IDs must be a nonempty list of positive integers. Reconnect GitHub.')
        allowed = set(allowed) if allowed is not None else None
        if config.get('access_token') or not config.get('app_id'):
            if not wanted:
                raise ConfigError('List repositories when testing with an access token.')
            for name in sorted(wanted):
                repo = github.get(f'/repos/{name}')
                if allowed is None or repo['id'] in allowed:
                    yield repo
            return
        for repo in github.pages('/installation/repositories', key='repositories'):
            if (allowed is None or repo['id'] in allowed) and (not wanted or repo['full_name'].lower() in wanted):
                yield repo

    def read(self, logger, config, catalog, state):
        selected = {s.stream.name for s in catalog.streams}
        incremental = {s.stream.name for s in catalog.streams if s.sync_mode == SyncMode.incremental}
        saved = {}
        for message in state or []:
            if message.type == AirbyteStateType.STREAM and message.stream and message.stream.stream_state:
                blob = message.stream.stream_state
                saved[message.stream.stream_descriptor.name] = dict(blob.__dict__) if hasattr(blob, '__dict__') else dict(blob)
        # Full-refresh streams start from nothing; incremental ones resume.
        current = {name: dict(saved.get(name) or {}) for name in selected if name in incremental}
        github = GitHub(config, logger)
        repos = list(self.repositories(github, config))
        logger.info(f'Reading {len(repos)} repositories')
        for name in sorted(selected):
            yield status(name, AirbyteStreamStatus.STARTED)
        counts = {name: 0 for name in selected}  # records since each stream's last state message
        out = queue.Queue(maxsize=2000)
        root = tempfile.mkdtemp(prefix='opencrawl-github-')
        done = object()

        def work(repo):
            try:
                for item in Reader(github, config, repo, current, selected, root, logger).run():
                    out.put(item)
            except Exception as error:  # noqa: BLE001 - surfaced after the queue drains
                out.put(('$error', repo['full_name'], error))
            finally:
                out.put(done)

        failures = []
        with ThreadPoolExecutor(max_workers=int(config.get('num_workers') or 4)) as pool:
            for repo in repos:
                pool.submit(work, repo)
            remaining = len(repos)
            while remaining:
                item = out.get()
                if item is done:
                    remaining -= 1
                elif item[0] == '$error':
                    failures.append(f'{item[1]}: {item[2]}')
                    logger.error(f'{item[1]}: {item[2]}')
                elif item[0] == '$state':
                    _, stream, repo_name, value = item
                    if stream in current:
                        current[stream][repo_name] = value
                        yield state_message(stream, current[stream], counts[stream])
                        counts[stream] = 0
                elif item[0] in selected:
                    counts[item[0]] += 1
                    yield record(*item)
        shutil.rmtree(root, ignore_errors=True)
        for name in sorted(selected):
            yield status(name, AirbyteStreamStatus.INCOMPLETE if failures else AirbyteStreamStatus.COMPLETE)
        if failures:
            raise RuntimeError(f'{len(failures)} of {len(repos)} repositories failed: ' + ' | '.join(failures)[:1500])


def record(stream, data):
    return AirbyteMessage(type=Type.RECORD, record=AirbyteRecordMessage(stream=stream, data=data, emitted_at=now_ms()))


def status(stream, value):
    return AirbyteMessage(type=Type.TRACE, trace=AirbyteTraceMessage(type=TraceType.STREAM_STATUS, emitted_at=now_ms(),
        stream_status=AirbyteStreamStatusTraceMessage(stream_descriptor=StreamDescriptor(name=stream), status=value)))


def state_message(stream, value, count):
    return AirbyteMessage(type=Type.STATE, state=AirbyteStateMessage(type=AirbyteStateType.STREAM,
        stream=AirbyteStreamState(stream_descriptor=StreamDescriptor(name=stream), stream_state=AirbyteStateBlob(value)),
        sourceStats=AirbyteStateStats(recordCount=float(count))))


if __name__ == '__main__':
    launch(SourceOpenCrawlGitHub(), sys.argv[1:])
