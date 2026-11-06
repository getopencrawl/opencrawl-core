import {invalidRecord} from './scope.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 20000;

/** Extract message-visible fields only. Never recursively index arbitrary Slack metadata.
 * Keep fallback text as well: it can carry information omitted from presentation blocks.
 * Binary files and content behind links are not fetched by this normalizer.
 */
export function slackMessageText(data) {
  const chunks = []; let size = 0, nodes = 0;
  function add(value) {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string') invalidRecord('Invalid Slack visible text');
    size += Buffer.byteLength(value);
    if (Buffer.byteLength(value) > MAX_BYTES || size > 2 * 1024 * 1024) invalidRecord('Slack visible content exceeds supported size');
    chunks.push(value);
  }
  function textObject(value) {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') return add(value);
    if (typeof value !== 'object' || Array.isArray(value)) invalidRecord('Invalid Slack text object');
    add(value.text);
  }
  function list(value, visit) {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) invalidRecord('Invalid Slack visible content list');
    for (const item of value) visit(item);
  }
  function option(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRecord('Invalid Slack option');
    if (++nodes > MAX_NODES) invalidRecord('Slack visible content is too complex');
    textObject(value.text); textObject(value.description);
    // value is an opaque action payload, not the label displayed to the reader.
  }
  function confirmation(value) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) invalidRecord('Invalid Slack confirmation');
    for (const field of ['title', 'text', 'confirm', 'deny']) textObject(value[field]);
  }
  function node(value, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRecord('Invalid Slack content node');
    if (++nodes > MAX_NODES || depth > 24) invalidRecord('Slack visible content is too complex');
    const children = v => list(v, x => node(x, depth + 1));
    switch (value.type) {
      case 'text': case 'plain_text': case 'mrkdwn': case 'markdown': add(value.text); break;
      case 'section': textObject(value.text); list(value.fields, textObject); if (value.accessory) node(value.accessory, depth + 1); break;
      case 'header': textObject(value.text); break;
      case 'context': case 'actions': case 'rich_text': case 'rich_text_list': children(value.elements); break;
      case 'rich_text_section': case 'rich_text_quote': case 'rich_text_preformatted': {
        // Formatting changes split inline elements, not words or lines. Keep
        // link destinations and accessibility alternatives outside the line.
        const inline = [], alternatives = [];
        list(value.elements, element => {
          const start = chunks.length;
          node(element, depth + 1);
          const rendered = chunks.splice(start);
          inline.push(rendered.shift() || '');
          alternatives.push(...rendered);
        });
        const line = inline.join('');
        if (line) chunks.push(line);
        chunks.push(...alternatives);
        break;
      }
      case 'table': list(value.rows, children); break;
      case 'link': add(value.text); add(value.url); break;
      case 'image': textObject(value.title); add(value.alt_text); break;
      case 'video': textObject(value.title); textObject(value.description); add(value.alt_text); break;
      case 'button': textObject(value.text); add(value.accessibility_label); break;
      case 'overflow': case 'static_select': case 'multi_static_select':
      case 'external_select': case 'multi_external_select': case 'radio_buttons': case 'checkboxes':
        textObject(value.placeholder);
        list(value.options, option);
        list(value.option_groups, group => {
          if (!group || typeof group !== 'object' || Array.isArray(group)) invalidRecord('Invalid Slack option group');
          textObject(group.label); list(group.options, option);
        });
        if (value.initial_option) option(value.initial_option);
        list(value.initial_options, option);
        break;
      case 'input': textObject(value.label); textObject(value.hint); if (value.element) node(value.element, depth + 1); break;
      case 'date': break; // Fallback is collected for every presentation node below.
      case 'emoji': if (value.name) add(':' + value.name + ':'); break;
      case 'user': if (value.user_id) add('<@' + value.user_id + '>'); break;
      case 'channel': if (value.channel_id) add('<#' + value.channel_id + '>'); break;
      case 'usergroup': if (value.usergroup_id) add('<!subteam^' + value.usergroup_id + '>'); break;
      case 'broadcast': if (value.range) add('<!' + value.range + '>'); break;
      case 'divider': case 'file': break; // No readable body; file labels come from files below.
      default:
        // Future block/control types may carry these documented presentation fields.
        // Do not visit value, metadata, action_id, callback_id, image_url or private URLs.
        textObject(value.text); textObject(value.title); textObject(value.description);
        textObject(value.placeholder); add(value.alt_text);
    }
    add(value.fallback);
    confirmation(value.confirm);
  }
  function group(visit) {
    const start = chunks.length;
    visit();
    const rendered = chunks.splice(start).join('\n');
    if (rendered) chunks.push(rendered);
  }
  function attribution(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) invalidRecord('Invalid Slack attribution');
    add(message.username);
    for (const [profile, fields] of [[message.bot_profile, ['name']], [message.user_profile, ['display_name', 'real_name', 'name', 'first_name']]]) {
      if (profile === undefined || profile === null) continue;
      if (typeof profile !== 'object' || Array.isArray(profile)) invalidRecord('Invalid Slack author profile');
      for (const field of fields) add(profile[field]);
    }
    list(message.reactions, reaction => {
      if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction)) invalidRecord('Invalid Slack reaction');
      if (++nodes > MAX_NODES) invalidRecord('Slack visible content is too complex');
      if (reaction.name === undefined || reaction.name === null || reaction.name === '') return;
      if (typeof reaction.name !== 'string') invalidRecord('Invalid Slack reaction label');
      add(':' + reaction.name + ':');
    });
  }
  add(data.text);
  list(data.blocks, value => group(() => node(value)));
  list(data.attachments, attachment => group(() => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) invalidRecord('Invalid Slack attachment');
    for (const field of ['pretext', 'author_name', 'service_name', 'title', 'text', 'fallback', 'footer']) add(attachment[field]);
    list(attachment.fields, field => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) invalidRecord('Invalid Slack attachment field');
      add(field.title); add(field.value);
    });
    list(attachment.blocks, value => node(value));
  }));
  list(data.files, file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) invalidRecord('Invalid Slack file');
    add(file.title); add(file.name);
  });
  // Public-message attribution and reaction labels are readable context too.
  // Keep this allowlist separate from profile contact fields, reaction user IDs,
  // action payloads and arbitrary metadata. A broadcast can carry parent labels;
  // the parent's body remains a separate native message document.
  attribution(data);
  if (data.root !== undefined && data.root !== null) attribution(data.root);
  // Deduplicate complete presentation units only. Dropping individual rich-text
  // fragments (or substrings of the fallback) can remove words and change phrases.
  const result = [...new Set(chunks)];
  const body = result.join('\n');
  if (Buffer.byteLength(body) > MAX_BYTES) invalidRecord('Slack visible content exceeds supported size');
  return body;
}
