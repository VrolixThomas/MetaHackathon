export type FixStage = 'queued' | 'reproducing' | 'fixing' | 'verifying' | 'proposed' | 'accepted' | 'author-approved' | 'needs-context'
export type IssueKind = 'filters' | 'empty-state' | 'accessibility' | 'unknown'
export type ProductView = 'board' | 'list'
export type TaskStatus = 'All statuses' | 'In progress' | 'In review' | 'Done'

export interface ReviewNote {
  id: number
  text: string
  target: string
  point: { x: number; y: number }
  screenshot?: string
  context: { view: ProductView; filter: TaskStatus; search: string; steps: string[] }
  kind: IssueKind
  stage: FixStage
}

export const stages: FixStage[] = ['queued', 'reproducing', 'fixing', 'verifying', 'proposed', 'accepted', 'author-approved']

export function identifyIssue(text: string): IssueKind {
  if (/filter|preserv|reset|switch.*view|remember.*status/i.test(text)) return 'filters'
  if (/empty|no results|nothing found|no tasks/i.test(text)) return 'empty-state'
  if (/accessib|screen reader|aria|label.*search|search.*label/i.test(text)) return 'accessibility'
  return 'unknown'
}

export function canTransition(current: FixStage, next: FixStage): boolean {
  if (current === 'needs-context' || next === 'needs-context') return current === 'queued' && next === 'needs-context'
  return stages.indexOf(next) === stages.indexOf(current) + 1
}

export function transitionNote(note: ReviewNote, stage: FixStage): ReviewNote {
  return canTransition(note.stage, stage) ? { ...note, stage } : note
}

export function canApprovePullRequest(notes: ReviewNote[]): boolean {
  return notes.every(note => note.stage === 'author-approved')
}

export function isPatched(notes: ReviewNote[], kind: IssueKind): boolean {
  return notes.some(note => note.kind === kind && ['proposed', 'accepted', 'author-approved'].includes(note.stage))
}

// This is also used by the interactive fixture. The regression checks exercise
// the behavior displayed in the preview, rather than a separate test-only copy.
export function filterAfterViewChange(current: TaskStatus, preserve: boolean): TaskStatus {
  return preserve ? current : 'All statuses'
}

export interface CheckResult { name: string; passed: boolean; detail: string }

export function runFilterChecks(preserve: boolean): CheckResult[] {
  return [
    { name: 'Keeps status when switching to list', passed: filterAfterViewChange('In progress', preserve) === 'In progress', detail: 'In progress → list → In progress' },
    { name: 'Keeps status when returning to board', passed: filterAfterViewChange('In review', preserve) === 'In review', detail: 'In review → board → In review' },
    { name: 'All statuses remains the default', passed: filterAfterViewChange('All statuses', preserve) === 'All statuses', detail: 'All statuses → list → All statuses' },
  ]
}

export const proposals: Record<Exclude<IssueKind, 'unknown'>, { title: string; description: string; file: string; removed: string[]; added: string[]; check: string }> = {
  filters: {
    title: 'Keep filters across views',
    description: 'Lift filter state into the shared task view. Switching between board and list now keeps the selected status.',
    file: 'useTaskFilters.ts',
    removed: ['const [status, setStatus] = useState("all");', 'useEffect(() => setStatus("all"), [view]);'],
    added: ['const [status, setStatus] = useTaskFilters();', '// Shared state survives view changes.'],
    check: '3 behavioral checks pass',
  },
  'empty-state': {
    title: 'Make an empty view useful',
    description: 'Show a clear empty state when no tasks match, with an action that clears the current search and filters.',
    file: 'TaskBoard.tsx',
    removed: ['return <TaskGrid tasks={filteredTasks} />;'],
    added: ['if (!filteredTasks.length) {', '  return <EmptyState onReset={clearFilters} />;', '}', 'return <TaskGrid tasks={filteredTasks} />;'],
    check: 'Empty-state fixture enabled',
  },
  accessibility: {
    title: 'Give task search an accessible name',
    description: 'Add an explicit accessible name so assistive technology can identify the task search field.',
    file: 'TaskBoard.tsx',
    removed: ['<input placeholder="Search tasks..." />'],
    added: ['<input', '  aria-label="Search tasks"', '  placeholder="Search tasks..."', '/>'],
    check: 'Accessible-name fixture enabled',
  },
}
