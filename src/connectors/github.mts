import type {ConnectorBinding, AirbyteEnvelope, GitHubRecord} from './types.mjs';
import {invalidRecord} from './scope.mjs';
import {id, text, time, resource} from './documents.mjs';

/** Explicit readable-field allowlist: never recurse into files, patches or code. */
export function normalizeGitHub(binding: ConnectorBinding, stream: string, envelope: AirbyteEnvelope<GitHubRecord>, sourceKey: string) {
  const d = envelope._airbyte_data, extractedAt = envelope._airbyte_extracted_at;
  const repository = text(d.repository);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) invalidRecord('Invalid GitHub repository');
  const root = `https://github.com/${repository}`;
  let kind, nativeId, title, body, url, relatedId = '';
  if (stream === 'commits') {
    kind = 'commit'; nativeId = id(d.sha); title = text(d.message).split('\n')[0]; body = text(d.message);
    url = `${root}/commit/${nativeId}`;
  } else if (stream === 'pull_requests' || stream === 'issues') {
    kind = stream === 'pull_requests' ? 'pull_request' : 'issue'; nativeId = id(d.number);
    title = `#${nativeId} ${text(d.title)}`; body = text(d.body); url = text(d.html_url || d.url);
    if (!url.startsWith('https://github.com/')) url = `${root}/${kind === 'issue' ? 'issues' : 'pull'}/${nativeId}`;
  } else if (stream === 'releases') {
    kind = 'release'; nativeId = id(d.id); title = text(d.name || d.tag_name); body = text(d.body); url = text(d.html_url);
  } else if (['issue_comments', 'review_comments', 'commit_comments'].includes(stream)) {
    kind = stream === 'review_comments' ? 'review_comment' : stream === 'commit_comments' ? 'commit_comment' : 'issue_comment';
    nativeId = id(d.id); title = `${repository} ${kind.replaceAll('_', ' ')}`; body = text(d.body); url = text(d.html_url);
    relatedId = text(d.commit_id || d.issue_url || d.pull_request_url);
  } else invalidRecord('Unsupported GitHub stream');
  const authorId = text(d.author?.login || d.user?.login || d.author_name);
  const labels = (d.labels || []).map(x => typeof x === 'string' ? text(x) : text(x.name));
  const metadata = {repository, authorId, state: text(d.state), relatedId, url,
    versionAt: time(d.updated_at || d.updatedAt || d.committer_date || d.published_at || d.created_at, extractedAt),
    timestamp: text(d.created_at || d.createdAt || d.author_date || d.published_at)};
  const docs = resource(binding, {kind, sourceId: repository + ':' + nativeId, title: `${repository} ${title}`,
    body: [body, authorId, ...labels, text(d.state), text(d.tag_name)].filter(Boolean).join('\n'), extractedAt, sourceKey, metadata});
  if (stream === 'pull_requests') {
    if (d.reviews != null && !Array.isArray(d.reviews)) invalidRecord('Invalid GitHub reviews');
    for (const review of d.reviews || []) docs.push(...resource(binding, {kind: 'review', sourceId: repository + ':' + id(review.databaseId ?? review.id),
      title: `${repository} #${nativeId} review`, body: [text(review.body), text(review.state)].filter(Boolean).join('\n'), extractedAt, sourceKey,
      metadata: {repository, relatedId: repository + ':' + nativeId, authorId: text(review.author?.login || review.user?.login),
        state: text(review.state), url: text(review.url || review.html_url), versionAt: time(review.updatedAt || review.submittedAt || review.submitted_at, metadata.versionAt)}}));
  }
  return docs;
}
