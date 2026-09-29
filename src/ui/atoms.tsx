import type { ReactNode } from 'react';

/** Inline icons only: no icon font to fetch, so the app stays fully offline. */
export function Icon({ name, size = 16 }: { name: string; size?: number }): ReactNode {
  const p = (d: string, extra?: ReactNode) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
      {extra}
    </svg>
  );
  switch (name) {
    case 'send':
      return p('M4 12l16-8-6 8 6 8-16-8z');
    case 'wave':
      return p('M2 12h2l2-6 3 12 3-16 3 14 2-4h3');
    case 'mic':
      return p('M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z', <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />);
    case 'shield':
      return p('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z');
    case 'gear':
      return p('M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', <path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1L15 3H9l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L2.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.3-1c.5.4 1.1.8 1.7 1L9 21h6l.4-2.6c.6-.2 1.2-.6 1.7-1l2.3 1 2-3.4z" />);
    case 'file':
      return p('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', <path d="M14 3v5h5" />);
    case 'download':
      return p('M12 4v11m0 0l-4-4m4 4l4-4', <path d="M4 19h16" />);
    case 'x':
      return p('M6 6l12 12M18 6L6 18');
    case 'check':
      return p('M4 12l5 5L20 6');
    case 'alert':
      return p('M12 4l9 16H3z', <path d="M12 10v4m0 3v.5" />);
    case 'info':
      return p('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', <path d="M12 11v5m0-8.5v.5" />);
    case 'refresh':
      return p('M20 11a8 8 0 1 0-1.5 5.5', <path d="M20 5v6h-6" />);
    case 'play':
      return p('M7 4l12 8-12 8z');
    case 'stop':
      return p('M6 6h12v12H6z');
    case 'lock':
      return p('M6 11h12v9H6z', <path d="M9 11V8a3 3 0 0 1 6 0v3" />);
    case 'unlock':
      return p('M6 11h12v9H6z', <path d="M9 11V8a3 3 0 0 1 5.8-1" />);
    case 'radio':
      return p('M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', <path d="M8.5 16.5a6 6 0 0 1 0-9M15.5 7.5a6 6 0 0 1 0 9M5.5 20a10 10 0 0 1 0-16M18.5 4a10 10 0 0 1 0 16" />);
    case 'speaker':
      return p('M4 9h3l5-4v14l-5-4H4z', <path d="M16 9a4 4 0 0 1 0 6" />);
    case 'target':
      return p('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', <path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />);
    case 'lab':
      return p('M9 3h6M10 3v6l-5 8a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 17l-5-8V3', <path d="M7.5 14h9" />);
    default:
      return p('M4 12h16');
  }
}

export function Panel({ title, icon, right, children, note }: { title: string; icon?: string; right?: ReactNode; children: ReactNode; note?: string }): ReactNode {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>
          {icon ? <Icon name={icon} size={15} /> : null}
          <span>{title}</span>
        </h2>
        <div className="panel-tools">{right}</div>
      </header>
      {note ? <p className="panel-note">{note}</p> : null}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Chip({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'live'; children: ReactNode; title?: string }): ReactNode {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn' | 'err' }): ReactNode {
  return (
    <div className={`stat${tone ? ' stat-' + tone : ''}`} title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }): ReactNode {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Button({ children, onClick, tone = 'default', disabled, title, type = 'button' }: { children: ReactNode; onClick?: () => void; tone?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; title?: string; type?: 'button' | 'submit' }): ReactNode {
  return (
    <button className={`btn btn-${tone}`} onClick={onClick} disabled={disabled} title={title} type={type}>
      {children}
    </button>
  );
}

export function Meter({ value, min = -60, max = 0, label, tone = 'live' }: { value: number; min?: number; max?: number; label?: string; tone?: 'live' | 'warn' }): ReactNode {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return (
    <div className="meter" title={label}>
      <div className={`meter-fill meter-${tone}`} style={{ width: `${(pct * 100).toFixed(1)}%` }} />
      <span className="meter-text">{label}</span>
    </div>
  );
}
