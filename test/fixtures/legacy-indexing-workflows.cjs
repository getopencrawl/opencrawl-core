// Frozen pre-pagination-guard behavior from 058ba204. Used only to generate
// real histories for replay/worker-upgrade regression tests.
const {proxyActivities, continueAsNew, ApplicationFailure} = require('@temporalio/workflow');
async function segment(input, {listPage, processObject}) {
  let cursor = input.cursor || null, indexed = 0, failed = 0;
  for (let page = 0; page < 5; page++) {
    const result = await listPage({...input, cursor});
    for (let offset = 0; offset < result.keys.length; offset += 2) {
      const results = await Promise.allSettled(result.keys.slice(offset, offset + 2).map(key => processObject({...input, key})));
      for (const result of results) {
        if (result.status === 'fulfilled') indexed += result.value.records;
        else failed++;
      }
    }
    cursor = result.cursor;
    if (!cursor) break;
  }
  return {cursor, indexed, failed};
}
const connectors = proxyActivities({startToCloseTimeout: '10 minutes', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 5}});
const sessions = proxyActivities({startToCloseTimeout: '5 minutes', heartbeatTimeout: '45 seconds',
  retry: {initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 5}});
exports.indexConnectorV1 = async function indexConnectorV1(input) {
  const result = await segment(input, connectors);
  const failed = (input.failed || 0) + result.failed;
  if (result.cursor) return continueAsNew({...input, cursor: result.cursor, failed});
  if (failed) throw ApplicationFailure.nonRetryable(`${failed} source objects failed; inspect failed activities and replay after repair`, 'ConnectorObjectsFailed');
  return result;
};
exports.indexSessionsV1 = async function indexSessionsV1(input) {
  const result = await segment(input, {listPage: sessions.listSessionPage, processObject: sessions.indexSessionObject});
  const failed = (input.failed || 0) + result.failed;
  if (result.cursor) return continueAsNew({...input, cursor: result.cursor, failed});
  if (failed) throw ApplicationFailure.nonRetryable(`${failed} session objects exhausted retries`, 'SessionObjectsFailed');
  return result;
};
