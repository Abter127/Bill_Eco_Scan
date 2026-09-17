/**
 * Templating primitives.
 *
 * C-01's acceptance criterion is "scan to readable bill under 3 s on 4G, cold
 * device, nothing installed". That rules out a client framework: the page is
 * HTML with its critical CSS inline, and no blocking script. Everything here
 * exists to make that cheap to write rather than to be a template engine.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Tagged template that escapes interpolations. Use `raw()` to opt out. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce<string>((acc, str, i) => {
    if (i === 0) return str;
    const v = values[i - 1];
    const rendered = Array.isArray(v)
      ? v.map((x) => (isRaw(x) ? x.value : esc(x))).join('')
      : isRaw(v) ? v.value : esc(v);
    return acc + rendered + str;
  }, '');
}

interface Raw { readonly __raw: true; readonly value: string }

export function raw(value: string): Raw {
  return { __raw: true, value };
}

function isRaw(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && (v as Raw).__raw === true;
}

export function when(condition: unknown, content: string): Raw {
  return raw(condition ? content : '');
}
