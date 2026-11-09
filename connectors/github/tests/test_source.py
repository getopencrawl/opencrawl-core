"""The GitHub source's git side, against a local repository (no network, no Airbyte)."""
import copy, logging, os, subprocess, sys, tempfile, types, unittest
from unittest.mock import patch
from pathlib import Path

# source.py runs inside the Airbyte image; stub what CI doesn't install.
for name in ['jwt', 'requests', 'airbyte_cdk', 'airbyte_cdk.entrypoint', 'airbyte_cdk.models', 'airbyte_cdk.sources', 'airbyte_cdk.sources.source']:
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['airbyte_cdk.entrypoint'].launch = None
sys.modules['airbyte_cdk.sources.source'].Source = object
models = sys.modules['airbyte_cdk.models']
for name in ['AirbyteCatalog', 'AirbyteConnectionStatus', 'AirbyteMessage', 'AirbyteRecordMessage', 'AirbyteStateBlob', 'AirbyteStateMessage', 'AirbyteStateStats',
             'AirbyteStateType', 'AirbyteStream', 'AirbyteStreamState', 'AirbyteStreamStatus', 'AirbyteStreamStatusTraceMessage', 'AirbyteTraceMessage',
             'ConnectorSpecification', 'Status', 'StreamDescriptor', 'SyncMode', 'TraceType', 'Type']:
    setattr(models, name, type(name, (), {}))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import source  # noqa: E402


class Anonymous:
    def token(self):
        return None


class RepositoryAccessTest(unittest.TestCase):
    def test_authorized_ids_exclude_other_and_new_installation_repositories(self):
        github = types.SimpleNamespace(pages=lambda *args, **kwargs: iter([
            {'id': 1, 'full_name': 'team/renamed'}, {'id': 2, 'full_name': 'team/secret'},
            {'id': 3, 'full_name': 'team/new'}]))
        config = {'app_id': 'owned', 'repository_ids': [1]}
        self.assertEqual(list(source.SourceOpenCrawlGitHub.repositories(github, config)), [{'id': 1, 'full_name': 'team/renamed'}])

    def test_invalid_empty_repository_grants_fail_closed(self):
        github = types.SimpleNamespace(pages=lambda *args, **kwargs: self.fail('must not enumerate repositories'))
        for ids in [[], [0], ['1'], [True], '1']:
            with self.subTest(ids=ids), self.assertRaises(source.ConfigError):
                list(source.SourceOpenCrawlGitHub.repositories(github, {'app_id': 'owned', 'repository_ids': ids}))


def sh(cwd, *args, env=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, 'GIT_AUTHOR_NAME': 'A', 'GIT_AUTHOR_EMAIL': 'a@x', 'GIT_COMMITTER_NAME': 'A', 'GIT_COMMITTER_EMAIL': 'a@x', **(env or {})}).stdout.strip()


class GitSideTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin = root / 'origin' / 'acme' / 'repo.git'
        self.origin.mkdir(parents=True)
        o = str(self.origin)
        sh(o, 'git', 'init', '-q', '-b', 'main')
        (self.origin / 'a.txt').write_text('one\n')
        (self.origin / 'logo.bin').write_bytes(b'\x00\x01binary')
        sh(o, 'git', 'add', '.'); sh(o, 'git', 'commit', '-qm', 'first')
        sh(o, 'git', 'checkout', '-qb', 'feature')
        (self.origin / 'b.txt').write_text('feature\n')
        sh(o, 'git', 'add', '.'); sh(o, 'git', 'commit', '-qm', 'feature work')
        sh(o, 'git', 'checkout', '-q', 'main')
        sh(o, 'git', 'mv', 'a.txt', 'renamed.txt'); sh(o, 'git', 'commit', '-qm', 'rename')
        sh(o, 'git', 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature')
        sh(o, 'git', 'tag', '-a', 'v1', '-m', 'release one')
        # A commit only a pull request ref points at.
        sh(o, 'git', 'checkout', '-qb', 'pr'); (self.origin / 'c.txt').write_text('pr\n')
        sh(o, 'git', 'add', '.'); sh(o, 'git', 'commit', '-qm', 'pr only')
        sh(o, 'git', 'update-ref', 'refs/pull/1/head', 'HEAD'); sh(o, 'git', 'checkout', '-q', 'main'); sh(o, 'git', 'branch', '-qD', 'pr')
        self.work = root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def reader(self, state, selected=('commits', 'files', 'branches', 'tags')):
        repo = {'full_name': 'acme/repo', 'default_branch': 'main'}
        reader = source.Reader(Anonymous(), {}, repo, state, set(selected), str(self.work), source.logging.getLogger('test'))
        clone = source.Git.clone
        source.Git.clone = lambda git: clone(git, base=str(self.origin.parent.parent))
        try:
            return list(reader.git())
        finally:
            source.Git.clone = clone

    def test_first_sync_reads_every_commit_once_with_diffs_and_every_file(self):
        out = self.reader({})
        commits = [r for s, r in [(i[0], i[1]) for i in out if i[0] != '$state'] if s == 'commits']
        self.assertEqual(len(commits), int(sh(str(self.origin), 'git', 'rev-list', '--all', '--count')))
        by = {c['message']: c for c in commits}
        self.assertIn('pr only', by)
        rename = by['rename']['files'][0]
        self.assertEqual((rename['path'], rename['previous_path']), ('renamed.txt', 'a.txt'))
        # The merge is shown against its first parent: only what the feature brought.
        self.assertEqual([f['path'] for f in by['merge feature']['files']], ['b.txt'])
        self.assertTrue(by['first']['files'][[f['path'] for f in by['first']['files']].index('logo.bin')]['binary'])
        self.assertIn('+one', by['first']['files'][[f['path'] for f in by['first']['files']].index('a.txt')]['patch'])
        files = {r['path']: r for s, r in [(i[0], i[1]) for i in out if i[0] != '$state'] if s == 'files'}
        self.assertEqual(sorted(files), ['b.txt', 'logo.bin', 'renamed.txt'])
        self.assertEqual(files['renamed.txt']['content'], 'one\n')
        self.assertTrue(files['logo.bin']['binary'])
        self.assertIsNone(files['logo.bin']['content'])
        tags = [r for s, r in [(i[0], i[1]) for i in out if i[0] != '$state'] if s == 'tags']
        self.assertEqual(tags[0]['message'].strip(), 'release one')

    def test_next_sync_sends_only_new_commits_and_changed_files(self):
        state = {}
        for item in self.reader({}):
            if item[0] == '$state':
                state.setdefault(item[1], {})[item[2]] = item[3]
        o = str(self.origin)
        (self.origin / 'renamed.txt').write_text('two\n'); (self.origin / 'b.txt').unlink()
        sh(o, 'git', 'commit', '-qam', 'edit and delete')
        out = [i for i in self.reader(state) if i[0] != '$state']
        self.assertEqual([r['message'] for s, r in out if s == 'commits'], ['edit and delete'])
        files = {r['path']: r for s, r in out if s == 'files'}
        self.assertEqual(sorted(files), ['b.txt', 'renamed.txt'])
        self.assertTrue(files['b.txt']['deleted'])
        self.assertEqual(files['renamed.txt']['content'], 'two\n')
        # Nothing new: nothing sent.
        for item in self.reader(state):
            if item[0] == '$state':
                state.setdefault(item[1], {})[item[2]] = item[3]
        self.assertEqual([i for i in self.reader(state) if i[0] in ('commits', 'files')], [])


def connection(nodes, total=None, after=None):
    return {'nodes': nodes, 'totalCount': len(nodes) if total is None else total,
            'pageInfo': {'hasNextPage': after is not None, 'endCursor': after}}


class DiscussionPaginationTest(unittest.TestCase):
    def reader(self, github):
        return source.Reader(github, {}, {'full_name': 'acme/repo'}, {}, {'discussions'}, '', logging.getLogger(__name__))

    def test_nested_comments_and_replies_are_complete_before_state(self):
        first = {'id': 'c1', 'body': 'first', 'replies': connection([{'id': 'r1'}], 2, 'r-after')}
        second = {'id': 'c2', 'body': 'last', 'replies': connection([])}
        discussion = {'id': 'd1', 'updatedAt': '2026-11-06T00:00:00Z', 'comments': connection([first], 2, 'c-after')}
        calls = []

        def graphql(query, variables):
            calls.append(variables)
            if query == source.DISCUSSION_QUERY:
                return {'repository': {'discussions': connection([copy.deepcopy(discussion)])}}
            if query == source.DISCUSSION_COMMENTS_QUERY:
                self.assertEqual(variables['id'], 'd1')
                self.assertEqual(variables['after'], 'c-after')
                return {'node': {'comments': connection([copy.deepcopy(second)], 2)}}
            self.assertEqual(query, source.DISCUSSION_REPLIES_QUERY)
            self.assertEqual(variables['id'], 'c1')
            self.assertEqual(variables['after'], 'r-after')
            return {'node': {'replies': connection([{'id': 'r2'}], 2)}}

        result = list(self.reader(types.SimpleNamespace(graphql=graphql)).discussions())
        self.assertEqual([c['id'] for c in result[0][1]['comments']], ['c1', 'c2'])
        self.assertEqual([r['id'] for r in result[0][1]['comments'][0]['replies']], ['r1', 'r2'])
        self.assertEqual(result[-1], ('$state', 'discussions', 'acme/repo', {'updated_at': discussion['updatedAt']}))
        self.assertEqual(len(calls), 3)

    def test_incomplete_nested_page_never_emits_record_or_checkpoint(self):
        for bad in [None, connection([], 2), connection([{'id': 'c1', 'replies': connection([])}], 2, 'repeat')]:
            with self.subTest(bad=bad):
                discussion = {'id': 'd1', 'updatedAt': '2026-11-06T00:00:00Z',
                              'comments': connection([{'id': 'c1', 'replies': connection([])}], 2, 'repeat')}
                def graphql(query, variables):
                    if query == source.DISCUSSION_QUERY:
                        return {'repository': {'discussions': connection([copy.deepcopy(discussion)])}}
                    return {'node': {'comments': bad}}
                iterator = self.reader(types.SimpleNamespace(graphql=graphql)).discussions()
                with self.assertRaises(RuntimeError):
                    next(iterator)

    def test_missing_root_or_nonadvancing_root_cursor_never_checkpoints(self):
        for payload in [{}, {'repository': {'discussions': connection([], 1, 'same')}}]:
            with self.subTest(payload=payload):
                iterator = self.reader(types.SimpleNamespace(graphql=lambda *_: payload)).discussions()
                with self.assertRaises(RuntimeError):
                    next(iterator)

    def test_partial_graphql_errors_fail_and_rate_limit_retries_are_bounded(self):
        client = object.__new__(source.GitHub)
        class Response:
            status_code = 200
            def raise_for_status(self):
                pass
            def json(self):
                return self.body
        response = Response()
        client.request = lambda *_args, **_kwargs: response
        response.body = {'data': {'repository': {}}, 'errors': [{'type': 'FORBIDDEN', 'message': 'denied field'}]}
        with self.assertRaisesRegex(RuntimeError, 'denied field'):
            client.graphql('query', {'first': 25})
        response.body = {'errors': [{'type': 'RATE_LIMITED'}]}
        with patch.object(source.time, 'sleep') as sleep:
            with self.assertRaises(RuntimeError):
                client.graphql('query', {'first': 25})
            self.assertEqual(sleep.call_count, 5)


class RestPaginationTest(unittest.TestCase):
    def test_lost_access_after_first_page_fails_instead_of_completing(self):
        client = object.__new__(source.GitHub)
        class Response:
            def __init__(self, status, items, next_url=None):
                self.status_code, self.items = status, items
                self.links = {'next': {'url': next_url}} if next_url else {}
            def raise_for_status(self):
                if self.status_code >= 400:
                    raise RuntimeError('lost access')
            def json(self):
                return self.items
        pages = iter([Response(200, [{'id': 1}], 'next'), Response(404, [])])
        client.request = lambda *_args, **_kwargs: next(pages)
        iterator = client.pages('/items')
        self.assertEqual(next(iterator), {'id': 1})
        with self.assertRaisesRegex(RuntimeError, 'lost access'):
            next(iterator)

    def test_repeated_rest_cursor_fails(self):
        client = object.__new__(source.GitHub)
        response = types.SimpleNamespace(links={'next': {'url': '/items'}}, raise_for_status=lambda: None, json=lambda: [])
        client.request = lambda *_args, **_kwargs: response
        with self.assertRaisesRegex(RuntimeError, 'pagination'):
            list(client.pages('/items'))


if __name__ == '__main__':
    unittest.main()
