/** Credential entry stays in memory and is submitted only to the current origin. */
export function requestSecret({title, body, label, placeholder, action}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'secret-dialog';
  dialog.setAttribute('aria-labelledby','connector-secret-title');
  dialog.setAttribute('aria-describedby','connector-secret-description');
  dialog.innerHTML = '<form method="dialog"><h2 id="connector-secret-title"></h2><p id="connector-secret-description"></p><label><span></span><input type="password" autocomplete="off" spellcheck="false" required maxlength="4096"></label><div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button value="confirm" class="primary"></button></div></form>';
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('p').textContent = body;
  dialog.querySelector('label span').textContent = label;
  dialog.querySelector('.primary').textContent = action;
  const input = dialog.querySelector('input');
  input.placeholder = placeholder || '';
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'confirm' ? input.value.trim() || null : null;
      input.value = ''; dialog.remove(); resolve(value);
    }, {once: true});
    dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close('cancel');});
    dialog.showModal(); input.focus();
  });
}
