import { Schema } from 'effect'
import type { Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import type { Game } from '@quorum/simulation/state'
import { SAMPLES, needsAction, randomSample, senderOf, type Fact } from './mail.ts'
import { Folder, type Inbox, type Mail } from './model.ts'

/* ==========================================================================
   The Inbox submodel (GDD 18): how Mail joins its Thread, resolves, and is
   read. Every function takes the Inbox and returns the next one; `update`
   handles the panel's gestures, and the parent folds it with foldChild.
   ========================================================================== */

const MAIL_KEPT = 40
const THREAD_ENTRIES = 20

/** Senders whose Mail is about the Design now: a Thread resolves when its cause is gone. */
const ADVISING = new Set(['cloud', 'monitoring', 'vendor', 'investor', 'finance', 'mentor'])

export const EMPTY_INBOX: Inbox = {
  mail: [],
  focus: null,
  peek: null,
  bucket: 0,
  sample: 'random',
  folder: 'action',
}

/** Mail waits for a decision (Needs action), or only informs (FYI), or the filter caught it (Spam). */
export const folderHolds = (mail: Mail, folder: Folder): boolean =>
  folder === 'trash'
    ? mail.trashed
    : !mail.trashed &&
      (folder === 'spam' ? mail.spam : !mail.spam && needsAction(mail) === (folder === 'action'))

/** A fact joins its Thread, or starts one. The same news twice changes nothing.
 *  `open` says the Inbox panel is on screen, so new Mail needs no preview card. */
export const mailed = (
  inbox: Inbox,
  fact: Fact,
  time: number,
  open: boolean,
  repeats = false,
): Inbox => {
  const existing = inbox.mail.find((mail) => mail.key === fact.key && !mail.trashed)
  if (
    !repeats &&
    existing &&
    existing.resolved === null &&
    existing.entries.at(-1)?.text === fact.text
  )
    return inbox
  const others = inbox.mail.filter((mail) => mail !== existing)
  const thread: Mail = existing
    ? {
        ...existing,
        time,
        read: false,
        answer: null,
        resolved: null,
        actions: fact.actions,
        entries: [...existing.entries, { time, text: fact.text }].slice(-THREAD_ENTRIES),
      }
    : {
        id: Math.max(0, ...inbox.mail.map((mail) => mail.id)) + 1,
        key: fact.key,
        sender: fact.sender,
        subject: fact.subject,
        time,
        entries: [{ time, text: fact.text }],
        actions: fact.actions,
        answer: null,
        read: false,
        trashed: false,
        spam: fact.spam,
        resolved: null,
      }
  // Mail that wants the player (a decision, or a provider, alarm or advisory) previews above the
  // Inbox button until it is read, so a new letter cannot go unnoticed.
  const loud =
    needsAction(thread) ||
    ['cloud', 'monitoring', 'security'].includes(senderOf(thread.sender).kind)
  const peek = !thread.spam && loud && !open ? thread.id : inbox.peek
  return { ...inbox, mail: [...others, thread].slice(-MAIL_KEPT), peek }
}

/** Advice about anything but `key` no longer holds. */
export const resolvedExcept = (inbox: Inbox, key: string, time: number): Inbox => ({
  ...inbox,
  mail: inbox.mail.map((mail) =>
    ADVISING.has(mail.sender) && mail.key !== key && mail.resolved === null
      ? { ...mail, resolved: time }
      : mail,
  ),
})

/** A Thread whose cause is over: it records the last line and resolves. */
export const closed = (inbox: Inbox, key: string, time: number, text: string): Inbox => ({
  ...inbox,
  mail: inbox.mail.map((mail) =>
    mail.key === key && !mail.trashed
      ? {
          ...mail,
          read: false,
          resolved: time,
          entries: [...mail.entries, { time, text }].slice(-THREAD_ENTRIES),
        }
      : mail,
  ),
})

/** The Mail in the open folder, newest first. */
export const folderList = (inbox: Inbox): ReadonlyArray<Mail> =>
  inbox.mail.filter((mail) => folderHolds(mail, inbox.folder)).reverse()

/** The Inbox opens on Needs action while something needs the player, and on FYI otherwise. */
export const openingFolder = (inbox: Inbox): Folder =>
  !inbox.mail.some((mail) => folderHolds(mail, 'action')) &&
  inbox.mail.some((mail) => folderHolds(mail, 'fyi'))
    ? 'fyi'
    : 'action'

/** The Inbox on one Mail, or the newest in its folder, which counts as read. */
export const reading = (inbox: Inbox, focus: number | null = null): Inbox => {
  const inFolder = folderList(inbox)
  const id = (inFolder.find((mail) => mail.id === focus) ?? inFolder[0])?.id ?? null
  return {
    ...inbox,
    focus: id,
    peek: null,
    mail: inbox.mail.map((mail) => (mail.id === id ? { ...mail, read: true } : mail)),
  }
}

export const withMail = (inbox: Inbox, id: number, change: Partial<Mail>): Inbox => ({
  ...inbox,
  mail: inbox.mail.map((mail) => (mail.id === id ? { ...mail, ...change } : mail)),
})

/* ---------- the panel's gestures ---------- */

export const InboxMessage = defineMessageUnion({
  /** Shows one Mail; null shows the newest in the folder. */
  Opened: { id: Schema.NullOr(Schema.Finite) },
  /** The preview card above the Inbox button opens its Mail in the panel. */
  PeekOpened: { id: Schema.Finite },
  PeekDismissed: {},
  Trashed: { id: Schema.Finite },
  Restored: { id: Schema.Finite },
  MarkedSpam: { id: Schema.Finite },
  FolderChosen: { folder: Folder },
  /** A button on a Mail. */
  Acted: { id: Schema.Finite, action: Schema.String },
  /** The Sandbox's mail generator. */
  SampleChosen: { id: Schema.String },
  Generated: { count: Schema.Finite },
  Resolved: {},
  Cleared: {},
})
export type InboxMessage = typeof InboxMessage.Type

/** What the parent does after a gesture: open the panel, or act on a Mail's button. */
export const InboxOutMessage = defineMessageUnion({
  PanelWanted: {},
  /** A button whose effect is outside the Inbox; its answer is already written. */
  ActionTaken: { kind: Schema.String, target: Schema.NullOr(Schema.String) },
})
export type InboxOutMessage = typeof InboxOutMessage.Type

/** What the Inbox reads from the board around it. */
export type InboxContext = Readonly<{ game: Game; open: boolean }>

/** The answer a button writes into its Mail; null for one that only acts. */
const answerOf = (kind: string | undefined, mail: Mail): string | null => {
  switch (kind) {
    case 'raise':
      return 'You raised the round.'
    case 'decline':
      return mail.sender.startsWith('mate:')
        ? 'You declined. They will bring it up again.'
        : 'You declined the round.'
    case 'hire':
      return 'You approved the hire.'
    case 'team':
      return 'You opened Team.'
    case 'later':
      return 'Later. They will ask again.'
    case 'first':
      return 'You moved the patch to the top.'
    case 'rush':
      return 'You rushed the patch.'
    case 'trap':
      return 'You clicked it. It was a trap: the address was not the real sender.'
    default:
      return null
  }
}

/** Buttons that only answer: a teammate's declined request, and Later. */
const answersOnly = (kind: string | undefined, mail: Mail): boolean =>
  kind === 'later' || (kind === 'decline' && mail.sender.startsWith('mate:'))

const ACTING = new Set([
  'raise',
  'decline',
  'hire',
  'team',
  'rewrite',
  'first',
  'rush',
  'show',
  'trap',
  'churn',
])

export const updateInbox = (
  inbox: Inbox,
  message: InboxMessage,
  context: InboxContext,
): Update.ReturnWithOutMessage<Inbox, InboxMessage, InboxOutMessage> =>
  InboxMessage.match<Update.ReturnWithOutMessage<Inbox, InboxMessage, InboxOutMessage>>(message, {
    Opened: ({ id }) => ({ model: reading(inbox, id) }),
    PeekOpened: ({ id }) => {
      const mail = inbox.mail.find((entry) => entry.id === id)
      const folder = mail?.spam ? 'spam' : mail && needsAction(mail) ? 'action' : 'fyi'
      return { model: reading({ ...inbox, folder }, id), outMessage: InboxOutMessage.PanelWanted() }
    },
    PeekDismissed: () => ({ model: { ...inbox, peek: null } }),
    Trashed: ({ id }) => ({ model: reading(withMail(inbox, id, { trashed: true })) }),
    Restored: ({ id }) => ({ model: reading(withMail(inbox, id, { trashed: false })) }),
    MarkedSpam: ({ id }) => {
      const mail = inbox.mail.find((entry) => entry.id === id)
      return { model: reading(withMail(inbox, id, { spam: !mail?.spam })) }
    },
    FolderChosen: ({ folder }) => ({ model: reading({ ...inbox, folder }) }),
    Acted: ({ id, action }) => {
      const mail = inbox.mail.find((entry) => entry.id === id)
      if (!mail) return { model: inbox }
      const [kind, target] = action.split(':')
      const unpeeked = { ...inbox, peek: inbox.peek === id ? null : inbox.peek }
      const answer = answerOf(kind, mail)
      const next = answer === null ? unpeeked : withMail(unpeeked, id, { answer })
      return kind && ACTING.has(kind) && !answersOnly(kind, mail)
        ? { model: next, outMessage: InboxOutMessage.ActionTaken({ kind, target: target ?? null }) }
        : { model: next }
    },
    SampleChosen: ({ id }) => ({ model: { ...inbox, sample: id } }),
    Generated: ({ count }) => {
      // Send uses the chosen sample; a burst of 10 or 50 draws a random sample for each Mail.
      const chosen = SAMPLES.find((entry) => entry.id === inbox.sample) ?? SAMPLES[0]
      if (!chosen) return { model: inbox }
      let next = inbox
      for (let sent = 0; sent < count; sent += 1) {
        const n = Math.max(0, ...next.mail.map((mail) => mail.id)) + 1
        const sample = count === 1 ? chosen : randomSample(context.game, n)
        next = mailed(next, sample.make(context.game, n), context.game.time, context.open)
      }
      return { model: reading(next, null) }
    },
    Resolved: () => ({ model: resolvedExcept(inbox, '', context.game.time) }),
    Cleared: () => ({ model: { ...inbox, mail: [], focus: null, peek: null } }),
  })
