# Slack reader (MET-66)

This module browses actual Slack metadata, bounded message history and thread pages. It has no
send/composer, provider credentials, direct provider requests, background history polling or product
fixtures. Test-only controlled data lives in `test-support.ts` and the two test files.

## Root bindings

Import from `renderer/slack/index.ts`; it also imports `slack.css`.

- `createSlackBrowseController(call: ConversationApi['call'])` returns `SlackBrowseController`.
- `SlackConversationList({ controller, selectedId?, onSelect(targetId) })` renders sidebar content.
- `SlackConversationView({ controller, selectedId?, onNavigate(targetId), beforeNavigate? })` renders
  the main reader or focused thread detail. `beforeNavigate` is an optional async root hook for
  explicit refresh/load-more reads. This module defines no speech policy.
- `CommandSidebar` accepts optional `slack?: SlackBrowseController`. Absent controller hides its rail
  entry. The root-owned `centerSections` and `HubIcon` must define `slack`. Count means actual loaded
  conversation metadata, with `+` when more pages are available; it is never an unread count.

Every selection, thread open and back action must call the root's acknowledged
`workspace.command({ kind: 'open-center', section: 'slack', selectedId: targetId })`. The Sidebar
already does this. The root must pass this same command through CenterCanvas's `onNavigate` prop.
Browsing the rail uses `browse-center`, preserving displayed work and foreground conversation.

Create one controller per runtime. Call `start()` for the first status/catalog page; the list also
starts it idempotently on mount. `refreshConversations()` replaces the catalog from page one;
`loadMoreConversations()` merges the next page. The sidebar search filters loaded names/IDs locally.
No timer reloads metadata or messages. Inactive sections therefore create no periodic history work.

`ensureTarget(encodedId): Promise<void>` validates the shared canonical selection and loads the
matching actual conversation metadata plus history/thread page. It rejects unavailable, invalid,
retired or mismatched reads. Repeated matching ensures coalesce or reuse the loaded source.
`refreshCurrent()` reloads page one; `loadOlder()` merges the next history page or next thread page.
Thread pagination is presented as “Load more thread messages” because Slack replies paginate forward.

The root display receipt gate must await `ensureTarget`, recheck action/session/generation and
`store.getState().loadedTarget === selectedId`, then wait two committed frames and verify the visible
DOM's exact `data-slack-target` value. That attribute exists only for the matching successfully loaded
source, including `/threadTs`; empty/loading/error/mismatched views never carry it. It establishes no
send permission. This controller stores one selected source at a time; do not expect two different
Slack targets to be simultaneously loaded from one controller.

Call `reset()` **synchronously** whenever root detects a provider/account/source authorization change,
before loading new source data. It clears catalog, messages, labels and display identity and retires
in-flight work. Then start/ensure again as appropriate. Do not depend on a message view being mounted
to perform this reset. Call `dispose()` at runtime teardown. A root cancelled action must never be
acknowledged solely because a controller promise resolved; root retains action cancellation authority.

## Read boundary and limits

All calls are queries: `slack.status`, `slack.conversations({cursor?})`,
`slack.conversation({conversationId})`, `slack.history({conversationId,cursor?})` and
`slack.thread({conversationId,threadTs,cursor?})`. Shared schemas validate replies. Actor/workspace,
conversation, visibility, source citations and exact thread identity are checked before adoption.
Status is checked before and after each read batch. Main remains responsible for actual current
authorization, membership, credential epochs, rate limits and provider request cancellation.
Renderer retirement stops waiting/adoption; it cannot cancel the underlying IPC query.

Requests have a 20-second local wait limit per query. The catalog holds up to 1,000 conversations and
the current source up to 600 messages; the last valid page is retained at capacity with explicit
refresh guidance. Cursors must advance; overlapping messages deduplicate by source ID, retain the
newest observed revision and deletion, and sort by exact Slack timestamp. Refresh replaces earlier
pages and author labels. This is a bounded reader, with no exhaustive-history or live-update claim.

Profile names come only from returned author metadata; missing names display actual author IDs.
Supported Slack mention/channel/link tokens become inert plain text; unsupported markup remains
literal and React escapes all source strings. There is no raw HTML or automatic link navigation.
No attachments, rich blocks, reactions, reply counts, unread/presence metadata or send controls are
invented from the text-only DTO.

## Author checks

`bun test apps/desktop/src/renderer/slack` runs controlled controller/SSR tests only. Native/app,
provider, physical media and combined workspace receipt acceptance belong to root. Existing root
presentation tests that enumerate rail sections must omit both optional `day` and optional `slack`
when those controllers are absent.
