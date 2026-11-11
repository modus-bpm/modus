// Signing in to the server, where it signs people in (MODUS_AUTH=password or oidc). Until then the
// Studio is the simulation only, exactly as on a static host; signed in, it can show the server Live.

import { LogIn, LogOut } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { liveStore } from '../server/live'
import { sessionStore } from '../server/session'
import { useSession } from '../server/useSession'
import { Button, Field, Input, Modal } from './ui'

/** Send the browser to the identity provider, to come back to this page. */
function toProvider(signIn: string) {
  window.location.assign(`${signIn}?return=${encodeURIComponent(`${window.location.pathname}${window.location.hash}`)}`)
}

export function SignIn() {
  const loaded = useSession((s) => s.loaded)
  const auth = useSession((s) => s.auth)
  const signedIn = useSession((s) => s.signedIn)
  const name = useSession((s) => s.user?.name)
  const signInUrl = useSession((s) => s.signInUrl)
  const [asking, setAsking] = useState(false)
  if (!loaded || auth === 'none') return null

  if (signedIn) {
    const out = async () => {
      await sessionStore.getState().signOut()
      // Everything shown came from the server: start over without it.
      window.location.reload()
    }
    return (
      <button
        type="button"
        onClick={() => void out()}
        title={name ? `Signed in to the server as ${name}. Sign out.` : 'Signed in to the server. Sign out.'}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      >
        {name && <span className="max-w-[160px] truncate max-[1199px]:hidden">{name}</span>}
        <LogOut size={15} aria-hidden />
        <span className="sr-only">Sign out</span>
      </button>
    )
  }

  return (
    <>
      <Button
        size="sm"
        variant="primary"
        title="Sign in to see and do the server’s live work. Without signing in, this is the simulation in your browser."
        onClick={() => (auth === 'oidc' && signInUrl ? toProvider(signInUrl) : setAsking(true))}
      >
        <LogIn size={14} aria-hidden />
        Sign in
      </Button>
      {asking && <PasswordForm onClose={() => setAsking(false)} />}
    </>
  )
}

function PasswordForm({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    const failed = await sessionStore.getState().signIn(password)
    setBusy(false)
    if (failed) return setError(failed)
    // In: the server's live work is there to show now.
    await liveStore.getState().detect()
    onClose()
  }
  return (
    <Modal open onClose={onClose} title="Sign in to this server" subtitle="It has one password for everyone trying it. Inside, you choose who to work as." width={420}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label="Password">
          <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-rose-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!password || busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
