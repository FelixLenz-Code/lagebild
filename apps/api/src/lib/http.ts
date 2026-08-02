/** fetch() mit JSON-Parsing und Timeout (bricht hängende Upstream-Requests ab). */
export async function fetchJson<T>(url: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'lagebild/0.1 (+https://github.com/FelixLenz-Code/lagebild)' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Wie fetchJson, aber für Text- und XML-Antworten. */
export async function fetchText(url: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'text/xml, text/plain, */*',
        'user-agent': 'lagebild/0.1 (+https://github.com/FelixLenz-Code/lagebild)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
