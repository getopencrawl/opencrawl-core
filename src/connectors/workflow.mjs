/** Deterministic orchestration, injected durable activities; no cloud/SDK dependency.
 * Adapter continues as new with the cursor after each bounded segment.
 */
export async function runConnectorSegment(input, {listPage, processObject}) {
  let cursor = input.cursor || null, indexed = 0, failed = 0;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await listPage({...input, cursor});
    for (let offset = 0; offset < page.keys.length; offset += 2) {
      const results = await Promise.allSettled(page.keys.slice(offset, offset + 2).map(key => processObject({...input, key})));
      for (const result of results) {
        if (result.status === 'fulfilled') indexed += result.value.records;
        else failed++;
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  return {cursor, indexed, failed};
}
