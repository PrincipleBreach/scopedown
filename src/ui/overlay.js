// Dialogs and toasts. Dialogs use the native <dialog> element for focus trapping and Escape,
// styled to match; toasts stack bottom-right and announce through a live region.

import { h } from './dom.js';
import { icon } from './icons.js';

// Resolves to the value of the pressed button ('confirm' or 'cancel'), plus any fields.
export function dialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', tone = 'default', fields = [] }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => (f.multiline
      ? h('textarea', { class: 'input', rows: f.rows || 4, placeholder: f.placeholder || '', 'aria-label': f.label })
      : h('input', { class: 'input', placeholder: f.placeholder || '', 'aria-label': f.label })));
    const el = h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' },
      h('form', { method: 'dialog' },
        h('div', { class: 'dialog-body' },
          h('h2', { id: 'dialog-title', text: title }),
          body ? h('div', { class: 'dialog-text' }, body) : null,
          fields.map((f, i) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: f.label }), inputs[i])),
        ),
        h('footer', { class: 'dialog-footer' },
          h('button', { class: 'action action--quiet', value: 'cancel', text: cancel }),
          h('button', { class: 'action', value: 'confirm', text: confirm, autofocus: !fields.length && tone !== 'danger' }),
        ),
      ),
    );
    document.body.append(el);
    el.addEventListener('close', () => {
      const values = Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value]));
      resolve({ action: el.returnValue || 'cancel', ...values });
      el.remove();
    });
    el.showModal();
    inputs[0]?.focus();
  });
}

let stack;
export function toast(message, { tone = 'default', action } = {}) {
  stack ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast toast-${tone}` },
    icon(tone === 'error' ? 'alert' : 'check'),
    h('span', { class: 'toast-text', text: message }),
    action ? h('button', { class: 'toast-action', onClick: () => { action.run(); el.remove(); }, text: action.label }) : null,
  );
  stack.append(el);
  setTimeout(() => el.classList.add('leaving'), tone === 'error' ? 6000 : 3200);
  setTimeout(() => el.remove(), tone === 'error' ? 6400 : 3600);
}
