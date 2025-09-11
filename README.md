## What is ORC?

(This page discusses ideas. For the specification, see [the spec](./SPEC.md))

Open Rooms Chat Protocl (ORC) is a new protocol for small group discussion. It is heavier than IRC, but lighter than XMPP, Matrix and more open than Slack, Dicord while offering features missing from older protocols and expected by modern users.

# Why?

Why another messaging system? The internet is still missing a Free (as in freedom, or maybe fun) chat protocol that is full-featured enough for serious use by a general audience but light weight enough to be customized and self managed.

## What We Lost When We Lost IRC

IRC once delivered on all the goals we’re describing:

* Open, self-hostable communities
* Diversity of moderation policies
* Simple, flexible integrations

It was everywhere - even CNN and Microsoft ran IRC servers. Its core strength was supporting group discussions and allowing extensibility.

But IRC didn’t adapt:

* Message history arrived a decade too late.
* Persistent sessions for mobile clients are unreliable.
* Join/part spam makes it unusable on flaky mobile connections.
* Modern expectations (history, search, long-lived sessions) never materialized, or appeared in a less capable form than competing alternatives.

IRCs decline stemmed from a failure to evolve, and the core strengths of the protocol are not seen elsewhere.

## Where IRC Failed

* Bouncers (BNCs): These are hacks, not solutions. Casual users are not going to provision a Digital Ocean droplet so that they can get scrollback history. They are going to close their IRC client and download an app.
* NickServ & MemoServ: Critical identity functions were bolted on as plugins.
* History/Search: IRCv3 history is too limited. The majority of real world servers still do not implement history.
* Mobile Support: Practically nonexistent.
* Join/Part Messages: Confusing noise for modern users who expect persistent chat history.

## Why Existing Alternatives Fall Short

### Matrix

* Over-engineered for privacy and encryption if you just want public group discussions.
* Adds cost without serving the “town square” use case.

### XMPP

* Close, but too complex for hobbyists.
* XML bad. You will not change my mind on this matter. I don't even want to have an intelligent discussion about it at this point. The scars are too deep.

### Discord, Slack, etc..

* The closest modern option.
* But it is proprietary, clients can be rug-pulled, and communities have no recourse.
* Discord governance is decent today (IMHO), there’s no guarantee it will remain so.

### That One Peer-to-Peer Thing Your Friend Uses

Much like E2E, P2P is a noble goal with real use cases. In the case of this protocol's goals, it will complicate a specification and hurt ecosystem diversity.

## Lessons from Gemini

The [Gemini protocol](https://geminiprotocol.net/) succeeded by embracing simplicity:

* Drew clear boundaries (no versioning, limited scope).
* Stable and widely adopted despite skepticism.
* Diversity of clients/servers shows the value of saying “no.”

This protocol should do the same: focus on a core set of features that are useful by default.

## Core Features for a Modern Protocol

### Users

* Profile photo, description, mutable name, immutable ID
* Status line + emoji

### Core Messaging

* DMs + group chats
* Text posts with formatting (bold, italics, code, etc.)
* Message editing & deletion
* Full history + search
* Push notifications (DMs & mentions)
* URL previews

### Rooms / Channels

* Named channels with topics/descriptions
* Persistent history
* Public vs private channels
* Pinned messages
* `/me` actions (because every serious chat protocol needs a `/me` command)

### Interaction

* Emoji reactions
* Threaded replies
* Mentions (@user, @everyone, etc.)

### Media & Files

* File attachments with inline previews
* URL Previews

### Presence & Notifications

* Online/away/DND indicators
* Typing indicators
* Custom per-channel notifications
* Server-level emoji (maybe)

### Collaboration

* Searchable user directory
* Roles/permissions
* External integrations (Google Drive, GitHub, Jira)
* Bots & automation (polls, reminders, workflows)
* Peer-to-peer transfers (e.g. via wormhole/DCC-like tools)

### Security

* 2FA
* OAuth support
* Kick/ban/mute/shadowban

## Explicit Non-Goals

* Read receipts (cause anxiety, harm fun).
* E2E encryption (adequate SSL privacy is enough).
* Voice/video channels (separate use case).
* Federation/sharding (protocol is designed for <10,000 users; no need to over-engineer).

## Success Metrics

* Client in a weekend - ensures simplicity and diversity of clients.
* Server in two weekends - avoids “one reference server” monoculture.
* LLM-implementable - unambiguous, contradiction-free spec. If you can vibe code a client or server in one pass, the spec is good.
* Runs on Arduino R4 - proves protocol doesn’t require bloated runtimes.
* Works on web, desktop, mobile - client diversity.
* Tolerant of frequent disconnects - no need for bouncers.

## Design Considerations

### Architecture

* Slow resources - HTTP/REST
* Fast events - WebSockets/TCP
* Capability system for partial implementations

### Technologies to Favor

* HTTP/HTTPS (unencrypted HTTP optional for LANs/retro use)
* JSON + JSON Schema
* Base32
* WebSockets
* TCP
* Content-addressed media (e.g. emojis, uploads)
* OpenAPI descriptors

### Technologies to Avoid

* WebRTC (too heavy)
* XML (outdated & cumbersome)
* Always-online requirements (bad for casuals)
* JavaScript runtimes as dependencies (similar issues with WebRTC)
* End-to-end encryption (not the use case)
* Peer-to-peer (same)

## Closing Thoughts

We don’t need to reinvent everything. We need a protocol that balances openness, simplicity, and community control, while avoiding the pitfalls of IRC’s stagnation and Matrix/XMPP’s over-engineering.

A protocol that works on desktop as well as mobile, can be hosted on hobbyist hardware, and is easy for developers to extend - that’s how we rebuild the internet’s small town squares.

**Please send me your feedback.**

# Appendix - List of Capabilities

This is mostly a list for myself as I write the spec out. Feel free to dive in.

1. Authenticate as guest or account to obtain an access token.
2. Refresh an expired access token without reauthenticating.
3. Create a new room with name and visibility.
4. Join an existing room by ID or invite.
5. Leave a room you previously joined.
6. Read room message history from a given sequence cursor.
7. Receive new messages in real time over WebSocket.
8. Send a message to a room.
9. Send a direct message to a user.
10. Reply to a message to start or continue a thread.
11. Edit your own message content.
12. Delete your own message (tombstone).
13. React to a message with an emoji.
14. Remove your own reaction from a message.
15. Upload a file and obtain a content ID (CID).
16. Attach an uploaded file to a message.
17. Download media by CID.
18. Search messages in a room by text query.
19. Search your DMs by text query.
20. Pin a message in a room if permitted.
21. Unpin a message in a room if permitted.
22. Set your display name.
23. Set your profile photo.
24. Set your profile description.
25. Set a custom status line.
26. Set a status emoji.
27. View another user’s profile.
28. View room topic and description.
29. View room member list.
30. Invite a user to a room if permitted.
31. Accept a room invite.
32. Decline a room invite.
33. Enable push notifications for mentions and DMs.
34. Send typing indicator.
35. See presence hints for members if enabled.
36. Acknowledge received messages to advance your cursor.
37. Resume after disconnect using stored cursors.
38. Rate-limit your client based on server hints.
39. Block a user to hide their messages locally.
40. List rooms you’re a member of.
41. Sign out the current device.
42. Revoke other device sessions if supported.
43. Use a bot token to post as a bot if permitted.
44. Create a webhook integration if permitted.
45. Configure per-room roles if you are an owner.
46. Assign or change a member’s role if you are an owner or admin.
47. Kick a member from a room if you are a moderator.
48. Ban a member from a room if you are a moderator.
49. Mute a member if you are a moderator.
50. Shadowban a member if you are an admin.
51. Lock a room to invites-only if you are an admin.
52. Edit the room name or topic if you are an admin.
53. Delete a pinned message if you are a moderator.
54. Purge a message for policy violations if you are a moderator.
55. View moderation logs if you are an admin.
56. View server capability flags and limits.
57. Opt out of link previews.
58. Report a message for moderation review.
59. Export your personal data if supported.
60. View unfurled link previews on messages.
61. Mention a user to trigger a notification
62. Mute notifications for a room.
63. Mute notifications for a thread.
64. Mute notifications for a specific user.
