import { useEffect, type JSX, type ReactNode } from 'react'
import { useStore } from '../store'
import { cx } from '../lib/util'
import { Icon, type IconName } from './Icon'

export function Toggle({
  on,
  onChange,
  ai
}: {
  on: boolean
  onChange: (v: boolean) => void
  ai?: boolean
}): JSX.Element {
  return (
    <button
      className={cx('toggle', on && 'is-on', ai && 'ai')}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className
}: {
  value: T
  options: { value: T; label: string; icon?: IconName }[]
  onChange: (v: T) => void
  className?: string
}): JSX.Element {
  return (
    <div className={cx('seg', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          className={cx(value === o.value && 'is-active')}
          onClick={() => onChange(o.value)}
          title={o.label}
        >
          {o.icon ? <Icon name={o.icon} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)}>
          <span className="mark" />
          <span style={{ flex: 1 }}>{t.message}</span>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function ConfirmDialog(): JSX.Element | null {
  const confirm = useStore((s) => s.confirm)
  const close = useStore((s) => s.closeConfirm)
  if (!confirm) return null
  return (
    <div
      className="backdrop"
      style={{ zIndex: 320 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal narrow">
        <div className="modal-head">
          <h2>{confirm.title}</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6 }}>{confirm.body}</p>
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button
            className={cx('btn', confirm.danger ? 'btn-danger' : 'btn-primary')}
            onClick={() => {
              confirm.onConfirm()
              close()
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ImportDock(): JSX.Element | null {
  const state = useStore((s) => s.importState)
  if (!state) return null
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0
  return (
    <div className="import-dock">
      <div className="row">
        <Icon name={state.phase === 'saving' ? 'layers' : 'image'} size={14} />
        <span className="name">
          {state.phase === 'saving' ? 'Saving to library…' : `Reading ${state.label}`}
        </span>
        <span className="mono">
          {state.done}/{state.total}
        </span>
      </div>
      <div className="track">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function ConvertDock(): JSX.Element | null {
  const state = useStore((s) => s.convertState)
  if (!state) return null
  const remaining = Math.max(0, state.total - state.done)
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0
  return (
    <div className="import-dock convert-dock">
      <div className="row">
        <Icon name="refresh" size={14} />
        <span className="name">
          {remaining > 0 ? `Converting ${state.label}` : 'Finishing conversion…'}
        </span>
        <span className="mono">{remaining} left</span>
      </div>
      <div className="track">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action
}: {
  icon: IconName
  title: string
  children?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-inner">
        <div className="empty-icon">
          <Icon name={icon} />
        </div>
        <h2>{title}</h2>
        {children ? <p>{children}</p> : null}
        {action}
      </div>
    </div>
  )
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  className
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // A confirmation dialog sits above this modal; let it close alone.
        if (document.querySelector('.modal.narrow')) return
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={cx('modal', className)}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? (
              <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 1 }}>{subtitle}</div>
            ) : null}
          </div>
          <div className="grow" />
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        {children}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd>{children}</kbd>
}
