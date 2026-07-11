const WORKSPACE_NAME_RE = /[^/\\]+$/;

function plural(n, one, many = one + 's') {
  return n === 1 ? one : many;
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function workspaceLabel(status) {
  const ws = status && typeof status.workspace === 'string' ? status.workspace.trim() : '';
  if (!ws) return '';
  const m = ws.match(WORKSPACE_NAME_RE);
  return m ? m[0] : ws;
}

export const SETUP_DISMISS_KEY = 'bc.setup-checklist.dismissed.v1';

export function buildSetupState(doc, status, connected, opts = {}) {
  const dismissed = !!opts.dismissed;
  const lieutenants = Array.isArray(doc && doc.lieutenants) ? doc.lieutenants : [];
  const cards = Array.isArray(doc && doc.cards) ? doc.cards : [];
  const projects = Array.isArray(doc && doc.projects) ? doc.projects : [];
  const workers = Array.isArray(doc && doc.workers) ? doc.workers : [];
  const registered = lieutenants.filter((lt) => lt && lt.ref && lt.ref.session);
  const harnesses = uniq([
    ...registered.map((lt) => lt.ref && lt.ref.harness),
    ...workers.map((w) => w && w.ref && w.ref.harness),
  ]);
  const ws = workspaceLabel(status);
  const queuePending = Number(status && status.queue_pending) || 0;
  const boardReady = !!doc && !!connected;
  const sessionsReady = registered.length > 0;
  const projectReady = projects.length > 0;
  const harnessReady = harnesses.length > 0 || workers.length > 0;
  const cardsReady = cards.length > 0;
  const canCreateCard = lieutenants.length > 0;
  const show = !dismissed && (!boardReady || !sessionsReady || !cardsReady || !projectReady);

  const items = [
    {
      key: 'board',
      label: 'Board connection',
      done: boardReady,
      detail: boardReady
        ? 'Live' + (ws ? ' for ' + ws : '') + (queuePending ? ' · ' + queuePending + ' pending ' + plural(queuePending, 'queue item') : '')
        : 'Waiting for the local board server…',
    },
    {
      key: 'session',
      label: 'Lieutenant / tmux session',
      done: sessionsReady,
      detail: sessionsReady
        ? registered.length + ' registered ' + plural(registered.length, 'session')
        : 'No lieutenant session is registered yet — add or re-register one from tmux.',
    },
    {
      key: 'project',
      label: 'Project integration',
      done: projectReady,
      optional: true,
      detail: projectReady
        ? projects.length + ' registered ' + plural(projects.length, 'project')
        : 'Optional: register a repo with bc-axi project add <url|path> --mode <mode>.',
    },
    {
      key: 'harness',
      label: 'Harness readiness',
      done: harnessReady,
      optional: !sessionsReady,
      detail: harnessReady
        ? 'Ready via ' + harnesses.join(', ') + (workers.length ? ' · ' + workers.length + ' live ' + plural(workers.length, 'worker') : '')
        : sessionsReady
          ? 'A lieutenant is registered; harness details appear once work starts.'
          : 'Register a lieutenant first so the board can attach to a real session.',
    },
    {
      key: 'card',
      label: 'First work item',
      done: cardsReady,
      detail: cardsReady
        ? cards.length + ' ' + plural(cards.length, 'card') + ' on the board'
        : canCreateCard
          ? 'Create a first card to start routing work through the board.'
          : 'Add a lieutenant first, then create the first card.',
    },
  ];

  const actions = [];
  if (!lieutenants.length) actions.push({ id: 'add-lieutenant', label: 'Add lieutenant' });
  if (canCreateCard && !cardsReady) actions.push({ id: 'create-card', label: 'Create first card' });
  actions.push({ id: 'dismiss', label: 'Hide checklist', secondary: true });

  let nextStep = 'Board is ready.';
  if (!sessionsReady) nextStep = 'Start by registering a lieutenant session from tmux.';
  else if (!cardsReady) nextStep = 'Next: create the first card so work can be delegated.';
  else if (!projectReady) nextStep = 'Optional next: register a project to enable worker worktrees and PR flows.';

  return {
    show,
    title: 'First-run setup checklist',
    summary: 'A lightweight readiness pass for this board before you start delegating work.',
    nextStep,
    items,
    actions,
    workspace: ws,
    counts: {
      lieutenants: lieutenants.length,
      registeredSessions: registered.length,
      projects: projects.length,
      workers: workers.length,
      cards: cards.length,
      queuePending,
    },
  };
}
