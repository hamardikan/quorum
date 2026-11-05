import { ResearchMessage } from './research.ts'
import { TeamMessage } from './team.ts'
import { DashboardMessage } from './dashboard.ts'
import { GlossaryMessage } from './glossary.ts'
import { InboxMessage } from './inbox.ts'
import { PrefsMessage } from './prefs.ts'
import { describe, expect, test } from 'vitest'
import { Option } from 'effect'
import { DragAndDrop } from '@foldkit/ui'
import { fromString } from 'foldkit/url'
import { newGame, preseedGame } from '@quorum/simulation/company'
import { COMPONENTS, researchList } from '@quorum/simulation/catalog'
import { researchReady } from '@quorum/simulation/lookups'
import { solveFlow } from '@quorum/simulation/solve'
import { SHARED } from '@quorum/simulation/playbook'
import { JOBS } from '@quorum/ui/board/jobs'
import { Message } from './message.ts'
import { titleIsOpen } from './boot-machine.ts'
import { boardChallenge, boardSandbox, type Mail, type Model } from './model.ts'
import { init, initialModel, update } from './update.ts'
import { AppRoute } from './route.ts'
import { CHALLENGES } from '@quorum/simulation/challenges'
import { boxOf, crowds } from '@quorum/ui/board/geometry'

/* The clock: 100 ms Steps under a 250 ms UI tick, and the Bottleneck search once per sim second. */

const tick = (model: Model, times = 1): Model => {
  let current = model
  for (let index = 0; index < times; index += 1) current = update(current, Message.Ticked()).model
  return current
}

const at = (path: string) => Option.getOrThrow(fromString(`https://quorum.test${path}`))

const inLab = (): Model => ({
  ...initialModel(),
  route: AppRoute.Company(),
  board: { ...initialModel().board, game: newGame() },
})

test('dropping an engineer on another team moves them', () => {
  const game = preseedGame()
  const start: Model = {
    ...inLab(),
    panel: 'team',
    board: {
      ...inLab().board,
      game: {
        ...game,
        teams: [
          ...game.teams,
          {
            id: 't2',
            name: 'Team 2',
            kind: 'product',
            policy: 'balanced',
            previous: 'balanced',
            since: 0,
          },
        ],
        engineers: [{ id: 'e1', team: 'core', language: 'php', hiredAt: 0 }],
      },
    },
  }
  const send = (model: Model, message: DragAndDrop.Message) =>
    update(model, Message.TeamChanged({ message: TeamMessage.DragChanged({ message }) })).model
  const picked = send(
    start,
    DragAndDrop.Message.ActivatedKeyboardDrag({ itemId: 'e1', containerId: 'core', index: 0 }),
  )
  const moved = send(
    picked,
    DragAndDrop.Message.CompletedResolveKeyboardMove({ targetContainerId: 't2', targetIndex: 0 }),
  )
  const dropped = send(moved, DragAndDrop.Message.ConfirmedKeyboardDrop())
  expect(dropped.board.game.engineers.find((engineer) => engineer.id === 'e1')?.team).toBe('t2')
})

test('the menu button opens a menu over the board that holds the clock, and Escape walks back out', () => {
  const key = Message.KeyPressed({ key: 'Escape' })
  const opened = update(inLab(), Message.PanelOpened({ panel: 'menu' }))
  expect(opened.model.route).toEqual(AppRoute.Company())
  expect(opened.model.board.clock.paused).toBe(false)
  expect(opened.commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'SyncBoard',
        args: expect.objectContaining({ paused: true }),
      }),
    ]),
  )
  const settings = update(opened.model, Message.PanelOpened({ panel: 'settings' })).model
  expect(update(settings, key).model.panel).toBe('menu')
  const resumed = update(opened.model, key)
  expect(resumed.model.panel).toBe('none')
  expect(resumed.commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'SyncBoard',
        args: expect.objectContaining({ paused: false }),
      }),
    ]),
  )
  expect(update(resumed.model, key).model.panel).toBe('menu')
})

test('Research suspends board rendering without holding the clock, and closing it resumes rendering', () => {
  const opened = update(inLab(), Message.PanelOpened({ panel: 'research' }))
  expect(opened.commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'SyncBoard',
        args: expect.objectContaining({ suspended: true, paused: false }),
      }),
    ]),
  )
  const advanced = tick(opened.model)
  expect(advanced.board.game.time).toBeGreaterThan(opened.model.board.game.time)
  expect(advanced.panel).toBe('research')
  for (const message of [Message.PanelClosed(), Message.KeyPressed({ key: 'Escape' })]) {
    const closed = update(advanced, message)
    expect(closed.model.panel).toBe('none')
    expect(closed.model.board.game).toBe(advanced.board.game)
    expect(closed.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'SyncBoard',
          args: expect.objectContaining({ suspended: false, paused: false }),
        }),
      ]),
    )
  }
})

describe('copy, cut, paste, and select all', () => {
  const send = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
    messages.reduce((current, message) => update(current, message).model, model)
  const key = (value: string) => Message.KeyPressed({ key: value })
  const start = (): Model => {
    const model = { ...inLab(), board: { ...inLab().board, game: { ...preseedGame(), cash: 1e6 } } }
    return send(
      model,
      Message.PlacingChosen({ type: 'server' }),
      Message.NodePlaced({ x: 400, y: 300 }),
    )
  }
  const movable = (model: Model) =>
    model.board.game.nodes.filter(
      (node) => !COMPONENTS[node.type].fixed && !SHARED.includes(node.type),
    )

  test('select all picks every Node that can be sold, and Delete sells them in one undo step', () => {
    const placed = start()
    const all = send(placed, key('Mod+a'))
    expect(all.board.selection).toEqual(movable(placed).map((node) => node.id))
    expect(all.board.selection.length).toBeGreaterThan(0)
    const asked = send(all, key('Delete'))
    expect(asked.board.game.nodes).toEqual(placed.board.game.nodes)
    expect(asked.board.confirmSell).toEqual(all.board.selection)
    expect(send(asked, key('Escape')).board.confirmSell).toBeNull()
    const sold = send(asked, key('Enter'))
    expect(movable(sold)).toEqual([])
    expect(sold.board.game.nodes.length).toBeLessThan(placed.board.game.nodes.length)
    expect(send(sold, key('z')).board.game.nodes).toEqual(placed.board.game.nodes)
  })

  test('paste places a second copy where the click lands, and it costs Cash', () => {
    const placed = start()
    const copied = send(placed, key('Mod+a'), key('Mod+c'))
    expect(copied.board.clipboard?.nodes.length).toBe(movable(placed).length)
    const stamping = send(copied, key('Mod+v'))
    expect(stamping.board.tool).toEqual({ _tag: 'Stamping', source: 'clipboard' })
    const pasted = send(stamping, Message.NodePlaced({ x: 900, y: 700 }))
    expect(movable(pasted).length).toBe(2 * movable(placed).length)
    expect(pasted.board.tool).toBeNull()
    expect(pasted.board.game.cash).toBeLessThan(placed.board.game.cash)
  })

  test('choosing a part while pasting places the part, not the paste', () => {
    const placed = start()
    const stamping = send(placed, key('Mod+a'), key('Mod+c'), key('Mod+v'))
    const chosen = send(stamping, Message.PlacingChosen({ type: 'server' }))
    const dropped = send(chosen, Message.NodePlaced({ x: 900, y: 700 }))
    expect(dropped.board.game.nodes.length).toBe(placed.board.game.nodes.length + 1)
    expect(dropped.board.game.nodes.at(-1)?.type).toBe('server')
  })

  test('cut sells the Nodes and keeps them to paste', () => {
    const placed = start()
    const cut = send(placed, key('Mod+a'), key('Mod+x'))
    expect(movable(cut)).toEqual([])
    expect(cut.board.clipboard?.nodes.length).toBe(movable(placed).length)
    const back = send(cut, key('Mod+v'), Message.NodePlaced({ x: 400, y: 300 }))
    expect(movable(back).length).toBe(movable(placed).length)
  })

  test('duplicate places a copy beside the original in one undo step', () => {
    const placed = start()
    const dup = send(placed, key('Mod+a'), key('Mod+d'))
    expect(movable(dup).length).toBe(2 * movable(placed).length)
    expect(dup.board.game.cash).toBeLessThan(placed.board.game.cash)
    expect(send(dup, key('z')).board.game.nodes).toEqual(placed.board.game.nodes)
  })

  test('Shift+Arrow nudges the selected Nodes', () => {
    const placed = start()
    const before = movable(placed)[0]!
    const moved = send(placed, key('Mod+a'), key('Shift+ArrowRight'))
    const after = movable(moved).find((node) => node.id === before.id)!
    expect(after.x - before.x).toBeGreaterThan(0)
    expect(after.y).toBe(before.y)
  })

  test('add and subtract edit a box selection; copy with nothing picked changes nothing', () => {
    const placed = start()
    const ids = movable(placed).map((node) => node.id)
    const added = send(placed, Message.SelectionBoxed({ ids, mode: 'add' }))
    expect([...added.board.selection].sort()).toEqual([...ids].sort())
    expect(send(added, Message.SelectionBoxed({ ids, mode: 'subtract' })).board.selection).toEqual(
      [],
    )
    expect(send(placed, key('Escape'), key('Mod+c')).board.clipboard).toBeNull()
  })

  test('dragging one selected Node moves the whole selection by the same step', () => {
    const placed = send(
      start(),
      Message.PlacingChosen({ type: 'database' }),
      Message.NodePlaced({ x: 800, y: 300 }),
    )
    const ids = movable(placed).map((node) => node.id)
    const [first, second] = movable(placed)
    const picked = send(placed, Message.SelectionBoxed({ ids, mode: 'replace' }))
    const moved = send(
      picked,
      Message.NodeMoved({ nodeId: first!.id, x: first!.x + 80, y: first!.y + 160 }),
    )
    const again = movable(moved)
    const step = { x: again[0]!.x - first!.x, y: again[0]!.y - first!.y }
    expect(step).not.toEqual({ x: 0, y: 0 })
    expect({ x: again[1]!.x - second!.x, y: again[1]!.y - second!.y }).toEqual(step)
  })

  test('paste with nothing copied does not start placing', () => {
    expect(send(start(), key('Mod+v')).board.tool).toBeNull()
  })
})

describe('the clock', () => {
  test('four ticks at 1× run ten 0.1 s Steps: one sim second', () => {
    const start = inLab()
    expect(tick(start, 2).board.game.time).toBeCloseTo(start.board.game.time + 0.5)
    expect(tick(start, 4).board.game.time).toBe(start.board.game.time + 1)
  })

  test('3× runs three times the Steps', () => {
    const lab = inLab()
    const start = { ...lab, board: { ...lab.board, clock: { ...lab.board.clock, speed: 3 } } }
    expect(tick(start, 4).board.game.time).toBe(start.board.game.time + 3)
  })

  test('the Bottleneck search runs once per sim second, and again after an action', () => {
    const first = tick(inLab())
    expect(first.board.bottleneckAt).toBe(Math.floor(first.board.game.time))
    const second = tick(first)
    expect(second.board.bottleneckAt).toBe(first.board.bottleneckAt)
    const acted = update(second, Message.ResizeChosen({ nodeId: 'server', direction: 1 })).model
    expect(acted.board.bottleneckAt).toBe(-1)
    expect(tick(acted).board.bottleneckAt).toBe(Math.floor(tick(acted).board.game.time))
  })

  test('component history captures traffic at its timestamp and stays pinned while live traffic changes', () => {
    const lab = inLab()
    const game = { ...preseedGame(), time: 9.9, autopilot: false }
    const first = tick({ ...lab, board: { ...lab.board, game, selected: 'database' } })
    const sample = first.board.nodeHistory.database![0]!
    const own = solveFlow(first.board.game).nodes.database!
    expect(sample.time).toBe(first.board.game.time)
    expect(sample.traffic).toEqual(own.traffic)
    expect(sample.traffic['q-read']).toBeGreaterThan(0)
    expect(sample.sources).toEqual([{ id: 'server', name: 'App Server', rate: own.inbound }])
    const chosen = update(
      first,
      Message.NodeSampleChosen({ nodeId: 'database', time: sample.time }),
    ).model
    expect(chosen.board.game).toBe(first.board.game)
    const after = tick({
      ...chosen,
      board: { ...chosen.board, game: { ...chosen.board.game, time: 19.9, users: game.users * 5 } },
    })
    expect(after.board.nodeSample).toEqual({ nodeId: 'database', time: sample.time })
    expect(after.board.nodeHistory.database![0]).toEqual(sample)
    expect(after.board.nodeHistory.database!.at(-1)!.traffic['q-read']).toBeGreaterThan(
      sample.traffic['q-read']!,
    )
    const live = update(after, Message.NodeSampleChosen({ nodeId: 'database', time: null })).model
    expect(live.board.nodeSample).toBeNull()
    expect(live.board.game).toBe(after.board.game)
    expect(
      update(after, Message.NodeTapped({ nodeId: 'server' })).model.board.nodeSample,
    ).toBeNull()
  })

  test('expired samples and sold components leave the bounded session history', () => {
    const lab = inLab()
    const first = tick({
      ...lab,
      board: { ...lab.board, game: { ...preseedGame(), time: 9.9, autopilot: false } },
    })
    const sample = first.board.nodeHistory.database![0]!
    const aged: Model = {
      ...first,
      board: {
        ...first.board,
        selected: 'database',
        nodeSample: { nodeId: 'database', time: sample.time },
        nodeHistory: {
          database: Array.from({ length: 145 }, (_, index) => ({
            ...sample,
            time: sample.time + index * 10,
          })),
          removed: [sample],
        },
        game: { ...first.board.game, time: 1459.9 },
      },
    }
    const after = tick(aged)
    expect(after.board.nodeHistory.database!.length).toBeLessThanOrEqual(144)
    expect(
      after.board.nodeHistory.database!.every((entry) => entry.time > after.board.game.time - 1440),
    ).toBe(true)
    expect(after.board.nodeHistory.removed).toBeUndefined()
    expect(after.board.nodeSample).toBeNull()
    expect(
      update(after, Message.NodeSampleChosen({ nodeId: 'database', time: sample.time })).model.board
        .nodeSample,
    ).toBeNull()
  })
})

describe('collecting the Payments drawer', () => {
  const send = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
    messages.reduce((current, message) => update(current, message).model, model)
  const withPending = (): Model => {
    const model = inLab()
    return { ...model, board: { ...model.board, game: { ...model.board.game, pending: 42 } } }
  }

  test('a tap on Payments opens the Inspector and leaves the drawer alone', () => {
    const start = withPending()
    const tapped = send(start, Message.NodeTapped({ nodeId: 'payments' }))
    expect(tapped.board.selected).toBe('payments')
    expect(tapped.board.game.pending).toBe(42)
    expect(tapped.board.game.cash).toBe(start.board.game.cash)
  })

  test('the footer Collect button collects without opening the Inspector', () => {
    const start = withPending()
    const pressed = send(start, Message.FooterPressed({ nodeId: 'payments' }))
    expect(pressed.board.selected).toBeNull()
    expect(pressed.board.game.pending).toBe(0)
    expect(pressed.board.game.cash).toBe(start.board.game.cash + 42)
  })

  test('an empty drawer still opens the Inspector', () => {
    const tapped = send(inLab(), Message.NodeTapped({ nodeId: 'payments' }))
    expect(tapped.board.selected).toBe('payments')
  })
})

describe('Tradeoff cards', () => {
  const option = { kind: 'runtime', id: 'node_cluster' } as const
  const ready = (): Model => ({
    ...initialModel(),
    route: AppRoute.Company(),
    board: {
      ...initialModel().board,
      selected: 'server',
      game: {
        ...preseedGame(),
        users: 4_000,
        researched: [...preseedGame().researched, 'lang-node', 'node-cluster'],
      },
    },
  })
  const send = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
    messages.reduce((current, message) => update(current, message).model, model)

  test('hovering asks the worker for a preview; leaving closes; the Game does not change', () => {
    const start = ready()
    const asked = update(start, Message.OptionPreviewed({ nodeId: 'server', option }))
    expect(asked.model.board.tradeoff?.preview).toBeNull()
    expect(asked.commands?.map((command) => command.name)).toContain('ComputePreview')
    const preview = JOBS.preview({ game: start.board.game, nodeId: 'server', option })
    if (!preview) throw new Error('The option was refused.')
    const hovered = send(
      asked.model,
      Message.PreviewComputed({
        nodeId: 'server',
        option,
        preview: { ...preview, burn: [...preview.burn] },
      }),
    )
    expect(hovered.board.tradeoff?.pinned).toBe(false)
    expect(hovered.board.tradeoff?.preview?.after.revenue).toBeGreaterThan(
      hovered.board.tradeoff?.preview?.before.revenue ?? Infinity,
    )
    expect(hovered.board.game).toBe(start.board.game)
    expect(send(hovered, Message.OptionLeft()).board.tradeoff).toBeNull()
  })

  test('the first click pins the card; Confirm applies it; the second time a click applies it', () => {
    const pinned = send(ready(), Message.OptionChosen({ nodeId: 'server', option }))
    expect(pinned.board.tradeoff?.pinned).toBe(true)
    expect(pinned.board.game.nodes.find((node) => node.id === 'server')?.runtime).toBe('php_fpm')
    // Leaving the option keeps a pinned card open.
    expect(send(pinned, Message.OptionLeft()).board.tradeoff?.pinned).toBe(true)
    // In a Company, Confirm starts a migration: Dev Hours first, then the strangler.
    const confirmed = send(pinned, Message.OptionConfirmed())
    expect(confirmed.board.tradeoff).toBeNull()
    expect(confirmed.prefs.seenTradeoffs).toEqual(['runtime'])
    expect(confirmed.board.game.nodes.find((node) => node.id === 'server')?.runtime).toBe('php_fpm')
    expect(confirmed.board.game.services[0]?.migration?.runtime).toBe('node_cluster')
    expect(confirmed.board.game.backlog.some((item) => item.kind === 'migration')).toBe(true)
    expect(confirmed.board.change).not.toBeNull()
    // The second time, a click applies at once.
    const fresh = { ...ready(), prefs: confirmed.prefs }
    const clicked = send(fresh, Message.OptionChosen({ nodeId: 'server', option }))
    expect(clicked.board.tradeoff).toBeNull()
    expect(clicked.board.game.services[0]?.migration?.runtime).toBe('node_cluster')
  })

  test('a Sandbox swaps the Stack at once', () => {
    const start = ready()
    const sandboxed = {
      ...start,
      board: { ...start.board, game: { ...start.board.game, sandbox: true } },
    }
    const applied = send(
      sandboxed,
      Message.OptionChosen({ nodeId: 'server', option }),
      Message.OptionConfirmed(),
    )
    expect(applied.board.game.nodes.find((node) => node.id === 'server')?.runtime).toBe(
      'node_cluster',
    )
  })

  test('Escape and Cancel close the card without changing anything', () => {
    const pinned = send(ready(), Message.OptionChosen({ nodeId: 'server', option }))
    expect(send(pinned, Message.KeyPressed({ key: 'Escape' })).board.tradeoff).toBeNull()
    expect(send(pinned, Message.TradeoffClosed()).board.game).toBe(pinned.board.game)
  })

  test('a locked option shows why, and Confirm does nothing', () => {
    const locked = { ...ready(), board: { ...ready().board, game: preseedGame() } }
    const pinned = send(locked, Message.OptionChosen({ nodeId: 'server', option }))
    expect(pinned.board.tradeoff?.refusal).toBeTruthy()
    expect(send(pinned, Message.OptionConfirmed()).board.game.nodes).toEqual(
      locked.board.game.nodes,
    )
  })

  test.each([
    ['Go', 'go', 'lang-go'],
    ['Zig', 'zig', 'lang-zig'],
    ['Haskell', 'warp', 'lang-haskell'],
  ] as const)(
    '%s mail reviews the proposed Stack even after runtime tradeoffs were seen',
    (language, runtime, research) => {
      const start = ready()
      const prepared: Model = {
        ...start,
        panel: 'inbox',
        prefs: { ...start.prefs, seenTradeoffs: ['runtime'] },
        board: {
          ...start.board,
          selected: 'database',
          selection: ['database'],
          game: { ...start.board.game, researched: [...start.board.game.researched, research] },
        },
      }
      const mailed = send(
        prepared,
        Message.InboxChanged({ message: InboxMessage.SampleChosen({ id: `rewrite:${language}` }) }),
        Message.InboxChanged({ message: InboxMessage.Generated({ count: 1 }) }),
      )
      const mail = mailed.board.inbox.mail.at(-1)!
      expect(mail.actions[0]).toEqual({
        id: `rewrite:${language}`,
        label: `Review ${language} migration`,
      })
      const reviewed = send(
        mailed,
        Message.InboxChanged({
          message: InboxMessage.Acted({ id: mail.id, action: mail.actions[0]!.id }),
        }),
      )
      expect(reviewed.panel).toBe('none')
      expect(reviewed.board.selected).toBe('server')
      expect(reviewed.board.selection).toEqual([])
      expect(reviewed.board.tradeoff).toMatchObject({
        nodeId: 'server',
        option: { kind: 'runtime', id: runtime },
        pinned: true,
        refusal: null,
      })
      expect(reviewed.board.game).toBe(mailed.board.game)
      expect(reviewed.board.inbox.mail.at(-1)?.answer).toBeNull()
      expect(send(reviewed, Message.TradeoffClosed()).board.game).toBe(mailed.board.game)
      const confirmed = send(reviewed, Message.OptionConfirmed())
      expect(confirmed.board.game.services[0]?.migration?.runtime).toBe(runtime)
      expect(confirmed.board.game.nodes.find((node) => node.id === 'server')?.runtime).toBe(
        'php_fpm',
      )
    },
  )

  test.each([
    ['Elixir', 'lang-elixir'],
    ['Zig', 'lang-zig'],
    ['Haskell', 'lang-haskell'],
  ])(
    'locked %s mail opens its research without answering or starting the migration',
    (language, research) => {
      const mailed = send(
        ready(),
        Message.InboxChanged({ message: InboxMessage.SampleChosen({ id: `rewrite:${language}` }) }),
        Message.InboxChanged({ message: InboxMessage.Generated({ count: 1 }) }),
      )
      const mail = mailed.board.inbox.mail.at(-1)!
      const reviewed = send(
        mailed,
        Message.InboxChanged({
          message: InboxMessage.Acted({ id: mail.id, action: mail.actions[0]!.id }),
        }),
      )
      expect(reviewed.panel).toBe('research')
      expect(reviewed.board.research.focus).toBe(research)
      expect(reviewed.board.game).toBe(mailed.board.game)
      expect(reviewed.board.inbox.mail.at(-1)?.answer).toBeNull()
    },
  )
})

describe('Exit and offline return', () => {
  const send = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
    messages.reduce((current, message) => update(current, message).model, model)

  test('an Exit pays Legacy, writes history, and the next company starts fresh with the record', () => {
    const game = { ...preseedGame(), stage: 4, users: 200_000, cash: 1e8 }
    const exited = send(
      { ...inLab(), board: { ...inLab().board, game } },
      Message.ExitTaken({ exit: 'acquisition' }),
    )
    expect(exited.panel).toBe('exited')
    expect(exited.founder.history).toHaveLength(1)
    expect(exited.founder.legacy).toBe(exited.founder.history[0]?.legacy)
    const title = send(exited, Message.TitleOpened())
    expect(title.route).toEqual(AppRoute.Menu({ menu: 'found' }))
    const next = send(title, Message.CompanyFounded())
    expect(next.route).toEqual(AppRoute.Company())
    expect(next.board.game.stage).toBe(0)
    expect(next.founder.history).toHaveLength(1)
  })

  test('a save from an hour ago plays the hour out and shows the return', () => {
    const game = { ...preseedGame(), wall: 1_000_000 }
    const loaded = send(
      initialModel(),
      Message.SavesLoaded({
        index: null,
        legacy: JSON.stringify(game),
        now: 1_000_000 + 3_600_000,
      }),
    )
    expect(loaded.loaded).toBe(true)
    expect(loaded.saves.current).not.toBeNull()
    expect(loaded.board.game.time).toBeCloseTo(game.time + 3_600)
    expect(loaded.board.away?.seconds).toBe(3_600)
    expect(loaded.board.game.incident).toBeNull()
    expect(send(loaded, Message.Continued()).panel).toBe('away')
  })
})

describe('Challenges', () => {
  const send = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
    messages.reduce((current, message) => update(current, message).model, model)
  const verdict = {
    passed: true,
    missed: null,
    score: { cost: 0.05, tail: 880, complexity: 2 },
    best: { cost: 0.05, tail: 880, complexity: 2 },
    percentiles: { cost: 0.5, tail: 0.5, complexity: 0 },
  }

  const solved = (model: Model): Model =>
    send(
      model,
      Message.ChallengeStarted({ id: 'hello-world' }),
      Message.FamilyChosen({ nodeId: 'server', family: 'general' }),
      Message.ChallengeRan(),
      Message.ChallengeFinished(),
    )

  /** The scored run, or a failed expectation when there is none. */
  const scoredRun = (model: Model) => {
    const run = boardChallenge(model.board)
    if (run?._tag !== 'Result') throw new Error('Expected a scored run.')
    return run
  }

  /** The run in progress, or a failed expectation when there is none. */
  const runningRun = (model: Model) => {
    const run = boardChallenge(model.board)
    if (run?._tag !== 'Running') throw new Error('Expected a run in progress.')
    return run
  }

  test('Run scores a provisional result, and the server confirms it', () => {
    const company = {
      ...initialModel(),
      saved: true,
      board: { ...initialModel().board, game: preseedGame() },
    }
    const done = solved(company)
    expect(boardChallenge(done.board)?._tag).toBe('Result')
    expect(scoredRun(done).result.passed).toBe(true)
    expect(scoredRun(done).verification).toBe('sending')
    expect(done.panel).toBe('challenge')
    const verified = send(done, Message.ChallengeVerified({ verdict }))
    expect(scoredRun(verified).verification).toBe('verified')
    // Leaving brings the Company back untouched.
    const left = send(verified, Message.TitleOpened())
    expect(boardChallenge(left.board)).toBeNull()
    expect(left.board.game).toBe(company.board.game)
  })

  test('a server reply that arrives after Rebuild leaves the build board alone', () => {
    const building = send(initialModel(), Message.ChallengeStarted({ id: 'hello-world' }))
    const late = send(building, Message.ChallengeVerified({ verdict }))
    expect(boardChallenge(late.board)).toEqual(boardChallenge(building.board))
  })

  test('a first completion pays Legacy once, and perks do not reach the board', () => {
    const founder = { ...initialModel().founder, perks: { 'angel-network': 3 } }
    const once = solved({ ...initialModel(), founder })
    expect(once.founder.legacy).toBe(1)
    expect(once.founder.completed).toEqual(['hello-world'])
    expect(once.board.game.founding.perks).toEqual({})
    const twice = solved(send(once, Message.TitleOpened()))
    expect(twice.founder.legacy).toBe(1)
  })

  test('the Design is fixed during a run; restarts are logged as run actions', () => {
    const running = send(
      initialModel(),
      Message.ChallengeStarted({ id: 'hello-world' }),
      Message.ChallengeRan(),
    )
    const resized = send(running, Message.FamilyChosen({ nodeId: 'server', family: 'general' }))
    expect(resized.board.game.nodes).toEqual(running.board.game.nodes)
    const built = send(
      initialModel(),
      Message.ChallengeStarted({ id: 'hello-world' }),
      Message.FamilyChosen({ nodeId: 'server', family: 'general' }),
      Message.ChallengeRan(),
    )
    expect(send(built, Message.UndoChosen()).board.game.nodes).toEqual(built.board.game.nodes)
    const restarted = send(running, Message.RestartChosen({ nodeId: 'server' }))
    expect(runningRun(restarted).replay.actions).toEqual([
      { step: 0, action: { _tag: 'Restart', node: 'server' } },
    ])
  })

  test('without the API Worker the result stays provisional', () => {
    const done = solved(initialModel())
    const offline = send(
      done,
      Message.ChallengeUnverified({ message: 'Failed to fetch', offline: true }),
    )
    expect(scoredRun(offline).verification).toBe('offline')
    expect(scoredRun(offline).result.passed).toBe(true)
  })

  test('a locked Challenge URL lands on the Challenge list; a completed one opens', () => {
    const locked = send(
      initialModel(),
      Message.ChangedUrl({ url: at('/challenges/split-the-box') }),
    )
    expect(boardChallenge(locked.board)).toBeNull()
    expect(locked.route).toEqual(AppRoute.Menu({ menu: 'challenges' }))
    const completed = {
      ...initialModel(),
      founder: { ...initialModel().founder, completed: ['hello-world'] },
    }
    const opened = send(completed, Message.ChangedUrl({ url: at('/challenges/split-the-box') }))
    expect(boardChallenge(opened.board)?.id).toBe('split-the-box')
  })

  test('every Challenge opens with its cards apart, and Run keeps them where they are', () => {
    for (const challenge of CHALLENGES) {
      const built = send(initialModel(), Message.ChallengeStarted({ id: challenge.id }))
      const nodes = built.board.game.nodes
      const crowded = nodes.flatMap((a, index) =>
        nodes
          .slice(index + 1)
          .filter((b) => a.region === b.region && crowds(boxOf(a), boxOf(b)))
          .map((b) => `${challenge.id}: ${a.id} and ${b.id}`),
      )
      expect(crowded).toEqual([])
      const running = send(built, Message.ChallengeRan())
      for (const node of running.board.game.nodes) {
        const before = nodes.find((entry) => entry.id === node.id)
        if (before) expect([node.x, node.y]).toEqual([before.x, before.y])
      }
    }
  }, 60_000)
})

describe('M9: sound, achievements, glossary, keys', () => {
  type Named = Readonly<{ name: string; args: Record<string, unknown> }>
  const names = (commands: ReadonlyArray<unknown> | undefined): ReadonlyArray<Named> =>
    (commands ?? []) as ReadonlyArray<Named>
  const incidentDue = (change: Partial<Model> = {}): Model => {
    const game = preseedGame()
    return {
      ...initialModel(),
      route: AppRoute.Company(),
      board: { ...initialModel().board, game: { ...game, nextIncidentAt: game.time } },
      ...change,
    }
  }
  const sounds = (model: Model) =>
    names(update(model, Message.Ticked()).commands)
      .filter((command) => command.name === 'PlaySound')
      .map((command) => command.args['sound'])

  test('a fresh load waits for one clock-in before the title, and a return skips it', () => {
    const shut = init(at('/')).model
    expect(shut.boot._tag).toBe('Shut')
    expect(update(shut, Message.KeyPressed({ key: 'Escape' })).model.boot._tag).toBe('Shut')
    const clocking = update(shut, Message.KeyPressed({ key: 'a' }))
    expect(clocking.model.boot._tag).toBe('Clocking')
    expect(names(clocking.commands).map((command) => command.args['sound'])).toContain('clockin')
    const again = names(update(clocking.model, Message.ClockedIn()).commands)
    expect(again.filter((command) => command.name !== 'AppendLog')).toEqual([])
    const open = update(clocking.model, Message.TitleRevealed()).model
    expect(open.boot._tag).toBe('Ready')
    const lab = update(open, Message.CompanyFounded()).model
    expect(titleIsOpen(update(lab, Message.TitleOpened()).model.boot)).toBe(true)
  })

  test('an incident plays its sound, unless muted', () => {
    expect(sounds(incidentDue())).toContain('incident')
    expect(sounds(incidentDue({ prefs: { ...initialModel().prefs, muted: true } }))).toEqual([])
  })

  test('an alarm from before a reset does not sound again on every tick', () => {
    const opened = update(inLab(), Message.FreeSandboxStarted()).model
    const alarm = {
      id: 1,
      key: 'alarm',
      sender: 'monitoring',
      subject: 'Errors are up',
      time: opened.board.game.time + 600,
      entries: [{ time: opened.board.game.time + 600, text: 'Errors are up.' }],
      actions: [],
      answer: null,
      read: false,
      trashed: false,
      spam: false,
      resolved: null,
    }
    const reset = update(
      { ...opened, board: { ...opened.board, inbox: { ...opened.board.inbox, mail: [alarm] } } },
      Message.FreeSandboxReset(),
    ).model
    expect(sounds(tick(reset))).not.toContain('warn')
  })

  test('the first served request earns Hello, World once, in the Founder record', () => {
    const once = update(incidentDue(), Message.Ticked()).model
    expect(once.founder.achievements).toContain('hello-world')
    expect(once.toast?.message).toBeDefined()
    const twice = update(once, Message.Ticked()).model
    expect(twice.founder.achievements.filter((id) => id === 'hello-world')).toHaveLength(1)
  })

  test('a Sandbox earns no achievement and meets no glossary entry', () => {
    const sandbox: Model = {
      ...inLab(),
      board: {
        ...inLab().board,
        game: { ...newGame(), sandbox: true },
        session: {
          _tag: 'Sandbox',
          run: { id: null, progress: { objective: 0, held: 0, fired: false } },
        },
      },
    }
    const after = update(sandbox, Message.Ticked()).model
    expect(after.founder.achievements).toEqual([])
    expect(after.founder.glossary).toEqual([])
  })

  test('mute and reduced motion are saved as prefs, not in the Game', () => {
    const start = inLab()
    const muted = update(start, Message.PrefsChanged({ message: PrefsMessage.MuteToggled() }))
    expect(muted.model.prefs.muted).toBe(true)
    expect(muted.model.board.game).toBe(start.board.game)
    const write = names(muted.commands).find((command) => command.name === 'WritePrefs')
    expect(write?.args['prefs']).toMatchObject({ muted: true, motion: 'system' })
    expect(update(start, Message.KeyPressed({ key: 'm' })).model.prefs.muted).toBe(true)
    expect(
      update(start, Message.PrefsChanged({ message: PrefsMessage.MotionToggled() })).model.prefs
        .motion,
    ).toBe('reduce')
  })

  test('a Tradeoff term opens the Glossary on it and marks it met', () => {
    const opened = update(inLab(), Message.GlossaryOpened({ id: 'event-loop' })).model
    expect(opened.panel).toBe('glossary')
    expect(opened.glossary.focus).toBe('event-loop')
    expect(opened.founder.glossary).toContain('event-loop')
  })

  test('arrow keys move the selection between Nodes', () => {
    const start: Model = { ...inLab(), board: { ...inLab().board, selected: 'users' } }
    const moved = update(start, Message.KeyPressed({ key: 'ArrowRight' })).model
    expect(moved.board.selected).not.toBe('users')
    expect(moved.board.selected).not.toBeNull()
  })
})

describe('URL routing', () => {
  type Named = Readonly<{ name: string; args: Record<string, unknown> }>
  const pushed = (commands: ReadonlyArray<unknown> | undefined) =>
    ((commands ?? []) as ReadonlyArray<Named>)
      .filter((command) => command.name === 'PushUrl' || command.name === 'ReplaceUrl')
      .map((command) => `${command.name} ${String(command.args['url'])}`)

  test('a board URL on a fresh load opens the menu that lists it', () => {
    const challenge = init(at('/challenges/hello-world'))
    expect(challenge.model.route).toEqual(AppRoute.Menu({ menu: 'challenges' }))
    expect(pushed(challenge.commands)).toEqual(['ReplaceUrl /challenges'])
    expect(pushed(init(at('/history')).commands)).toEqual([])
    expect(init(at('/no/such/page')).model.route).toEqual(AppRoute.Title())
  })

  test('opening a Sandbox adds its URL; back closes it and gives the Company back', () => {
    const company = inLab()
    const opened = update(company, Message.FreeSandboxStarted())
    expect(opened.model.route).toEqual(AppRoute.Sandbox({ sandbox: 'free' }))
    expect(pushed(opened.commands)).toEqual(['PushUrl /sandbox/free'])

    const back = update(opened.model, Message.ChangedUrl({ url: at('/') }))
    expect(back.model.route).toEqual(AppRoute.Title())
    expect(boardSandbox(back.model.board)).toBeNull()
    expect(back.model.board.game).toBe(company.board.game)
    expect(pushed(back.commands)).toEqual([])

    const forward = update(back.model, Message.ChangedUrl({ url: at('/sandbox/second-server') }))
    expect(boardSandbox(forward.model.board)?.id).toBe('second-server')
    expect(pushed(forward.commands)).toEqual([])
  })

  test('a URL for a board that cannot open goes back to the screen in place', () => {
    const title = initialModel()
    const company = update(title, Message.ChangedUrl({ url: at('/company') }))
    expect(company.model.route).toEqual(AppRoute.Title())
    expect(pushed(company.commands)).toEqual(['ReplaceUrl /'])
    const unknown = update(title, Message.ChangedUrl({ url: at('/challenges/no-such-drill') }))
    expect(pushed(unknown.commands)).toEqual(['ReplaceUrl /'])
  })
})

describe('progressive disclosure', () => {
  const send = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
    messages.reduce((current, message) => update(current, message).model, model)
  /** Founding from the title plays the monitor's connect sequence; the board takes keys once it ends. */
  const founded = (): Model => {
    const connecting = send(initialModel(), Message.CompanyFounded())
    expect(connecting.boot._tag).toBe('Connecting')
    expect(send(connecting, Message.KeyPressed({ key: 'r' })).panel).toBe('none')
    const open = send(connecting, Message.Connected())
    expect(open.boot._tag).toBe('Ready')
    return open
  }

  test('a first Company opens on the board, with Research shut until Insight can buy an item', () => {
    const start = founded()
    expect(start.panel).toBe('none')
    expect(start.board.disclosure.revealed).not.toContain('research')
    expect(send(start, Message.KeyPressed({ key: 'r' })).panel).toBe('none')
    // The cheapest Garage item costs 15 Insight: 14 is not enough, 15 is.
    const short = tick({
      ...start,
      board: { ...start.board, game: { ...start.board.game, insight: 14 } },
    })
    expect(short.board.disclosure.revealed).not.toContain('research')
    const enough = tick({
      ...start,
      board: { ...start.board, game: { ...start.board.game, insight: 15 } },
    })
    expect(enough.board.disclosure.revealed).toContain('research')
    expect(enough.board.disclosure.cue?.key).toBe('research')
    const opened = send(enough, Message.KeyPressed({ key: 'r' }))
    expect(opened.panel).toBe('research')
    expect(opened.board.disclosure.cue).toBeNull()
  })

  test('two triggers at once show one element; the second waits until the first is used', () => {
    const start = founded()
    const both = tick(
      send(
        {
          ...start,
          board: { ...start.board, game: { ...start.board.game, insight: 100, cash: 10_000 } },
        },
        Message.ResizeChosen({ nodeId: 'server', direction: 1 }),
      ),
    )
    expect(both.board.disclosure.revealed).toContain('undo')
    expect(both.board.disclosure.revealed).not.toContain('research')
    expect(both.board.disclosure.pending).toContain('research')
    const used = tick(send(both, Message.UndoChosen()))
    expect(used.board.disclosure.revealed).toContain('research')
    expect(used.board.disclosure.cue?.key).toBe('research')
  })

  test('a save from before disclosure shows everything; a save with it keeps its set', () => {
    const game = preseedGame()
    const old = send(
      initialModel(),
      Message.SavesLoaded({ index: null, legacy: JSON.stringify(game), now: 0 }),
    )
    expect(old.board.disclosure.revealed).toContain('team')
    expect(old.board.disclosure.revealed).toContain('glossary')
    const kept = send(
      initialModel(),
      Message.SavesLoaded({
        index: null,
        legacy: JSON.stringify({ ...game, disclosure: { revealed: ['undo'], pending: ['team'] } }),
        now: 0,
      }),
    )
    expect(kept.board.disclosure.revealed).toEqual(['undo'])
    expect(kept.board.disclosure.pending).toEqual(['team'])
  })
})

test('tidying the board groups nodes into a band per zone, in flow order', () => {
  const game = newGame()
  const [first, second, third] = game.nodes
  const model: Model = {
    ...inLab(),
    board: {
      ...inLab().board,
      game: {
        ...game,
        links: [{ ...game.links[0]!, from: 'p', to: 'q' }],
        nodes: [
          { ...first!, id: 'q', type: 'server', zone: 'a', x: 40, y: 500 },
          { ...second!, id: 'p', type: 'server', zone: 'a', x: 400, y: 300 },
          { ...third!, id: 'r', type: 'server', zone: 'b', x: 10, y: 50 },
        ],
      },
    },
  }
  const [q, p, r] = update(model, Message.BoardTidied()).model.board.game.nodes
  expect(p!.x).toBeLessThan(q!.x)
  expect(p!.y).toBe(q!.y)
  expect(r!.y).toBeGreaterThan(q!.y)
})

test('losing focus pauses the clock and focus resumes it, unless the setting is off', () => {
  const blurred = update(inLab(), Message.WindowBlurred()).model
  expect(blurred.board.clock.paused).toBe(true)
  expect(update(blurred, Message.WindowFocused()).model.board.clock.paused).toBe(false)
  const manual = update(inLab(), Message.PauseToggled()).model
  expect(update(manual, Message.WindowFocused()).model.board.clock.paused).toBe(true)
  const off = update(
    inLab(),
    Message.PrefsChanged({ message: PrefsMessage.BlurPauseToggled() }),
  ).model
  expect(update(off, Message.WindowBlurred()).model.board.clock.paused).toBe(false)
})

test('a queued Study can run now, keeping the running one’s progress, and be cancelled', () => {
  const ready = researchList.filter((entry) => researchReady(newGame(), entry.id))
  const [first, second] = ready
  if (!first || !second) throw new Error('needs two open items')
  const lab = inLab()
  const queued: Model = {
    ...lab,
    board: {
      ...lab.board,
      game: {
        ...lab.board.game,
        studies: [
          { id: first.id, progress: 0.25 },
          { id: second.id, progress: 0 },
        ],
      },
    },
  }
  const now = update(
    queued,
    Message.ResearchChanged({ message: ResearchMessage.StudyPrioritized({ id: second.id }) }),
  ).model
  expect(now.board.game.studies).toEqual([
    { id: second.id, progress: 0 },
    { id: first.id, progress: 0.25 },
  ])
  const back = update(
    now,
    Message.ResearchChanged({
      message: ResearchMessage.StudyMoved({ id: first.id, direction: -1 }),
    }),
  ).model
  expect(back.board.game.studies.map((item) => item.id)).toEqual([first.id, second.id])
  const cancelled = update(
    back,
    Message.ResearchChanged({ message: ResearchMessage.StudyCancelled({ id: first.id }) }),
  ).model
  expect(cancelled.board.game.studies).toEqual([{ id: second.id, progress: 0 }])
})

test('pointer-rate Messages stay out of the playtest log, and gestures go in', () => {
  const names = (result: ReturnType<typeof update>) =>
    (result.commands ?? []).map((command) => command.name)
  const hovered = update(
    inLab(),
    Message.DashboardChanged({ message: DashboardMessage.Hovered({ index: 3 }) }),
  )
  expect(names(hovered)).not.toContain('AppendLog')
  const found = update(inLab(), Message.BottleneckFound({ bottleneck: null, at: 0 }))
  expect(names(found)).not.toContain('AppendLog')
  const opened = update(inLab(), Message.PanelOpened({ panel: 'menu' }))
  expect(names(opened)).toContain('AppendLog')
})

test('a save this version cannot read is kept aside instead of dropped', () => {
  const game = newGame()
  const saved = JSON.stringify({ ...game, wall: 0 })
  const loaded = update(initialModel(), Message.SavesLoaded({ index: null, legacy: saved, now: 0 }))
  expect(loaded.model.loaded).toBe(true)
  expect(loaded.model.saves.current).not.toBeNull()
  expect(loaded.model.board.game.nodes).toEqual(game.nodes)

  const renamed = JSON.stringify({
    ...game,
    wall: 0,
    nodes: game.nodes.map((node) => ({ ...node, type: 'retired-component' })),
  })
  for (const json of [renamed, '{not json']) {
    const broken = update(
      initialModel(),
      Message.SavesLoaded({ index: null, legacy: json, now: 0 }),
    )
    expect(broken.model.loaded).toBe(false)
    expect(broken.model.toast?.tone).toBe('warn')
    expect(broken.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'KeepBrokenSave',
          args: expect.objectContaining({ json }),
        }),
      ]),
    )
  }
})

test('the board redraws after any Message that changes what it shows, and fits after the redraw', () => {
  const syncs = (result: ReturnType<typeof update>) =>
    (result.commands ?? []).filter((command) => command.name === 'SyncBoard')
  const placing = update(inLab(), Message.PlacingChosen({ type: 'server' })).model
  // Opening the Glossary drops the part off the pointer, so the board must hear about it.
  const glossary = update(placing, Message.GlossaryOpened({ id: null }))
  expect(syncs(glossary)).toEqual([
    expect.objectContaining({ args: expect.objectContaining({ placing: null, fit: false }) }),
  ])
  expect(
    syncs(
      update(
        glossary.model,
        Message.GlossaryChanged({ message: GlossaryMessage.Searched({ query: 'cache' }) }),
      ),
    ),
  ).toEqual([])

  const entered = update(initialModel(), Message.FreeSandboxStarted())
  const names = (entered.commands ?? []).map((command) => command.name)
  expect(names).not.toContain('FitBoard')
  expect(syncs(entered)).toEqual([
    expect.objectContaining({ args: expect.objectContaining({ fit: true }) }),
  ])
  const fitted = update(entered.model, Message.BoardFitted())
  expect((fitted.commands ?? []).map((command) => command.name)).toContain('FitBoard')
  expect(syncs(fitted)).toEqual([])
})

test("a toast from the last board cannot clear the next board's toast", () => {
  const raised = update(inLab(), Message.ToastRaised({ message: 'Old news.', tone: 'plain' })).model
  const oldId = raised.toast?.id
  const entered = update(raised, Message.FreeSandboxStarted()).model
  const fresh = update(entered, Message.ToastRaised({ message: 'New news.', tone: 'plain' })).model
  const cleared = update(fresh, Message.ToastCleared({ id: oldId ?? -1 })).model
  expect(cleared.toast?.message).toBe('New news.')
})

test('a Company comes back from a Sandbox as it was: its Inbox, history and undo too', () => {
  let company = update(
    inLab(),
    Message.InboxChanged({ message: InboxMessage.Generated({ count: 3 }) }),
  ).model
  for (let index = 0; index < 40; index += 1) company = update(company, Message.Ticked()).model
  const sandbox = update(company, Message.FreeSandboxStarted()).model
  expect(sandbox.board.inbox.mail).toEqual([])
  const back = update(update(sandbox, Message.TitleOpened()).model, Message.Continued()).model
  expect(back.board.game).toBe(company.board.game)
  expect(back.board.inbox).toEqual(company.board.inbox)
  expect(back.board.dashboard.history).toEqual(company.board.dashboard.history)
  expect(back.board.undo).toEqual(company.board.undo)
})

test('the Inbox opens on Needs action while something needs the player, and on FYI otherwise', () => {
  const letter: Mail = {
    id: 1,
    key: 'mentor:grow:0',
    sender: 'mentor',
    subject: 'On the way to Pre-seed',
    time: 0,
    entries: [{ time: 0, text: 'Grow to 1,000 users.' }],
    actions: [],
    answer: null,
    read: false,
    trashed: false,
    spam: false,
    resolved: null,
  }
  const offer = { ...letter, id: 2, key: 'offer', actions: [{ id: 'raise', label: 'Raise' }] }
  const start = inLab()
  const opened = (mail: ReadonlyArray<Mail>) =>
    update(
      { ...start, board: { ...start.board, inbox: { ...start.board.inbox, mail } } },
      Message.PanelOpened({ panel: 'inbox' }),
    ).model.board.inbox
  expect(opened([letter])).toMatchObject({ folder: 'fyi', focus: 1 })
  // Read letters still beat an empty "Nothing needs you." pane.
  expect(opened([{ ...letter, read: true }])).toMatchObject({ folder: 'fyi', focus: 1 })
  expect(opened([]).folder).toBe('action')
  expect(opened([letter, offer])).toMatchObject({ folder: 'action', focus: 2 })
})
