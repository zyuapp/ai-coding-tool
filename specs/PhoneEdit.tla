----------------------------- MODULE PhoneEdit -----------------------------
(***************************************************************************)
(* A phone edits a queued message held by computer B, through computer A   *)
(* (mobile server, MobileRelay, window answerEdit). The edit takes the     *)
(* message out of B's queue; its words must then wait in the phone's draft *)
(* or A's composer, and never in both or after the message ran.            *)
(*                                                                         *)
(*  phone   ios/AICodingTool/Client/ClientReducer.swift                    *)
(*  server  src/main/mobile/mobile-server.mts onSessionMessage             *)
(*  relay   src/main/mobile/session-host.mts MobileRelay                   *)
(*  window  src/host/mobile-bridge.ts answerEdit                           *)
(*  holder  task.drop-queued ifWaiting                                     *)
(*                                                                         *)
(* Not modeled: A dying while B's answer to a drop is on its way. Nothing  *)
(* durable holds the words then, so ServerRestart waits for that answer.   *)
(* A remembers each edit's outcome on disk, so a phone resends an edit to  *)
(* a restarted A rather than letting it go.                                *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
  MaxDisconnects,     \* bound on phone line drops
  AllowPhoneKill,     \* iOS ends the app; the outbox, and the edit's words with it, are stored
  AllowSwitch,        \* the phone talks to another computer, then comes back
  AllowServerRestart, \* A restarts: relay and window promises are gone; edit outcomes are stored
  AllowRelayTimeout,  \* the relay gives up before the window has started on the request
  AllowRemind         \* the phone writes a sent command again on a live line

VARIABLES
  q,          \* B's message: "queued" | "dropped" | "ran"
  mirror,     \* A's copy of B's queue
  drops,      \* drop attempts on their way A -> B
  replies,    \* [a, ok] on their way B -> A
  att,        \* window's attempt: "none"|"pending"|"waiting"|"late"|"answered"|"dead"
  relay,      \* "none"|"asking"|"timedout"|"answered"
  composerA,  \* the words wait in A's composer
  handled,    \* A's memory of the phone's request: "none"|"inflight"|"ok"|"fail"
  toServer,   \* copies of the request in flight to A
  toPhone,    \* acks in flight to the phone
  live, disconnects,
  outbox,     \* the phone's stored entry, words included
  phoneDraft, \* the words wait in the phone's draft
  tapped, killed, switched, restarts

vars == <<q, mirror, drops, replies, att, relay, composerA, handled, toServer, toPhone,
          live, disconnects, outbox, phoneDraft, tapped, killed, switched, restarts>>

Attempts == 1..3

Init ==
  /\ q = "queued" /\ mirror = "queued" /\ drops = <<>> /\ replies = <<>>
  /\ att = [a \in Attempts |-> "none"] /\ relay = [a \in Attempts |-> "none"]
  /\ composerA = FALSE /\ handled = "none" /\ toServer = 0 /\ toPhone = {}
  /\ live = TRUE /\ disconnects = 0
  /\ outbox = FALSE /\ phoneDraft = FALSE
  /\ tapped = FALSE /\ killed = FALSE /\ switched = FALSE /\ restarts = 0

LineDrops == live' = FALSE /\ toServer' = 0 /\ toPhone' = {}

---------------------------------------------------------------------------
(* Phone. An edit is never given up on: only the computer's answer settles it. *)

\* The words ride in the outbox entry, so they are kept wherever the entry is.
TapEdit ==
  /\ ~tapped /\ mirror = "queued"
  /\ tapped' = TRUE
  /\ outbox' = TRUE
  /\ toServer' = IF live THEN toServer + 1 ELSE toServer
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled, toPhone,
                 live, disconnects, phoneDraft, killed, switched, restarts>>

Remind ==
  /\ AllowRemind /\ live /\ outbox /\ toServer < 2
  /\ toServer' = toServer + 1
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled, toPhone,
                 live, disconnects, outbox, phoneDraft, tapped, killed, switched, restarts>>

Disconnect ==
  /\ live /\ disconnects < MaxDisconnects
  /\ LineDrops /\ disconnects' = disconnects + 1
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled,
                 outbox, phoneDraft, tapped, killed, switched, restarts>>

PhoneKill ==
  /\ AllowPhoneKill /\ ~killed /\ live
  /\ LineDrops /\ killed' = TRUE
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled,
                 disconnects, outbox, phoneDraft, tapped, switched, restarts>>

\* Another computer's outbox is shown meanwhile; this one's stays stored until the phone comes back.
SwitchAway ==
  /\ AllowSwitch /\ ~switched /\ live
  /\ LineDrops /\ switched' = TRUE
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled,
                 disconnects, outbox, phoneDraft, tapped, killed, restarts>>

\* Back on the line, an edit still owed an answer is written again, to whichever server instance is there.
Reconnect ==
  /\ ~live
  /\ live' = TRUE /\ toServer' = IF outbox THEN 1 ELSE 0
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled, toPhone,
                 disconnects, outbox, phoneDraft, tapped, killed, switched, restarts>>

\* An answer to the entry still held settles it; taken, its words fill the draft.
ReceiveAck ==
  /\ live /\ toPhone # {}
  /\ \E ok \in toPhone :
       /\ toPhone' = toPhone \ {ok}
       /\ phoneDraft' = (phoneDraft \/ (ok = "ok" /\ outbox))
       /\ outbox' = FALSE
  /\ UNCHANGED <<q, mirror, drops, replies, att, relay, composerA, handled, toServer,
                 live, disconnects, tapped, killed, switched, restarts>>

---------------------------------------------------------------------------
(* A: server dedup, relay, window *)

\* A request already handled is answered from memory; a new one is relayed to the window.
ServerReceive ==
  /\ live /\ toServer > 0
  /\ toServer' = toServer - 1
  /\ CASE handled \in {"ok", "fail"} ->
            /\ toPhone' = toPhone \cup {handled}
            /\ UNCHANGED <<handled, att, relay>>
       [] handled = "inflight" -> UNCHANGED <<toPhone, handled, att, relay>>
       [] OTHER ->
            /\ \E a \in Attempts : att[a] = "none"
            /\ LET a == CHOOSE x \in Attempts : att[x] = "none" IN
                 /\ att' = [att EXCEPT ![a] = "pending"]
                 /\ relay' = [relay EXCEPT ![a] = "asking"]
            /\ handled' = "inflight"
            /\ UNCHANGED toPhone
  /\ UNCHANGED <<q, mirror, drops, replies, composerA, live, disconnects,
                 outbox, phoneDraft, tapped, killed, switched, restarts>>

\* The relay settles the phone's request with the first answer it gets.
Settle(a, out) ==
  IF relay[a] = "asking"
  THEN /\ relay' = [relay EXCEPT ![a] = "answered"]
       /\ handled' = out
       /\ toPhone' = IF live THEN toPhone \cup {out} ELSE toPhone
  ELSE UNCHANGED <<relay, handled, toPhone>>

\* The window starts on the request: one past the relay's deadline takes nothing out.
WindowStart ==
  /\ \E a \in Attempts :
       /\ att[a] = "pending"
       /\ IF relay[a] = "asking" /\ mirror = "queued"
          THEN /\ att' = [att EXCEPT ![a] = "waiting"]
               /\ drops' = Append(drops, a)
               /\ UNCHANGED <<relay, handled, toPhone>>
          ELSE /\ att' = [att EXCEPT ![a] = "answered"]
               /\ Settle(a, "fail")
               /\ UNCHANGED drops
  /\ UNCHANGED <<q, mirror, replies, composerA, toServer, live, disconnects,
                 outbox, phoneDraft, tapped, killed, switched, restarts>>

\* B's answer: in time, it goes to the phone; late, a drop leaves the words in A's composer.
WindowReply ==
  /\ replies # <<>>
  /\ LET r == Head(replies) IN
     /\ replies' = Tail(replies)
     /\ CASE att[r.a] = "waiting" ->
               /\ att' = [att EXCEPT ![r.a] = "answered"]
               /\ Settle(r.a, IF r.ok THEN "ok" ELSE "fail")
               /\ UNCHANGED composerA
          [] att[r.a] = "late" ->
               /\ att' = [att EXCEPT ![r.a] = "answered"]
               /\ composerA' = (composerA \/ r.ok)
               /\ UNCHANGED <<relay, handled, toPhone>>
          [] OTHER -> UNCHANGED <<att, relay, handled, toPhone, composerA>>
  /\ UNCHANGED <<q, mirror, drops, toServer, live, disconnects,
                 outbox, phoneDraft, tapped, killed, switched, restarts>>

\* The window stops waiting on B, still inside the relay's deadline, and tells the phone so.
WindowLate ==
  /\ \E a \in Attempts :
       /\ att[a] = "waiting"
       /\ att' = [att EXCEPT ![a] = "late"]
       /\ Settle(a, "fail")
  /\ UNCHANGED <<q, mirror, drops, replies, composerA, toServer, live, disconnects,
                 outbox, phoneDraft, tapped, killed, switched, restarts>>

\* Once the window has started it always answers first, so the relay can only give up before then.
RelayTimeout ==
  /\ AllowRelayTimeout
  /\ \E a \in Attempts :
       /\ att[a] = "pending" /\ relay[a] = "asking"
       /\ relay' = [relay EXCEPT ![a] = "timedout"]
       /\ handled' = "fail"
       /\ toPhone' = IF live THEN toPhone \cup {"fail"} ELSE toPhone
  /\ UNCHANGED <<q, mirror, drops, replies, att, composerA, toServer, live, disconnects,
                 outbox, phoneDraft, tapped, killed, switched, restarts>>

ServerRestart ==
  /\ AllowServerRestart /\ restarts < 1
  /\ \A a \in Attempts : att[a] \notin {"waiting", "late"}
  /\ restarts' = restarts + 1
  /\ handled' = IF handled \in {"ok", "fail"} THEN handled ELSE "none"
  /\ att' = [a \in Attempts |-> IF att[a] = "pending" THEN "dead" ELSE att[a]]
  /\ relay' = [a \in Attempts |-> IF relay[a] = "asking" THEN "timedout" ELSE relay[a]]
  /\ LineDrops
  /\ UNCHANGED <<q, mirror, drops, replies, composerA, disconnects, outbox,
                 phoneDraft, tapped, killed, switched>>

---------------------------------------------------------------------------
(* B *)

Drain ==
  /\ q = "queued" /\ q' = "ran"
  /\ UNCHANGED <<mirror, drops, replies, att, relay, composerA, handled, toServer, toPhone,
                 live, disconnects, outbox, phoneDraft, tapped, killed, switched, restarts>>

HolderDrop ==
  /\ drops # <<>>
  /\ drops' = Tail(drops)
  /\ replies' = Append(replies, [a |-> Head(drops), ok |-> (q = "queued")])
  /\ q' = IF q = "queued" THEN "dropped" ELSE q
  /\ UNCHANGED <<mirror, att, relay, composerA, handled, toServer, toPhone,
                 live, disconnects, outbox, phoneDraft, tapped, killed, switched, restarts>>

Sync ==
  /\ mirror # q /\ mirror' = q
  /\ UNCHANGED <<q, drops, replies, att, relay, composerA, handled, toServer, toPhone,
                 live, disconnects, outbox, phoneDraft, tapped, killed, switched, restarts>>

---------------------------------------------------------------------------
Next ==
  \/ TapEdit \/ Remind \/ Disconnect \/ PhoneKill \/ SwitchAway \/ Reconnect \/ ReceiveAck
  \/ ServerReceive \/ WindowStart \/ WindowReply \/ WindowLate \/ RelayTimeout \/ ServerRestart
  \/ Drain \/ HolderDrop \/ Sync

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
TypeOK ==
  /\ q \in {"queued", "dropped", "ran"}
  /\ toServer \in 0..3
  /\ \A a \in Attempts : att[a] \in {"none", "pending", "waiting", "late", "answered", "dead"}

\* Words never wait in two places, or after their message ran.
NoDuplicate ==
  /\ ~(q = "ran" /\ (phoneDraft \/ composerA))
  /\ ~(phoneDraft /\ composerA)

Quiescent ==
  /\ toServer = 0 /\ toPhone = {} /\ drops = <<>> /\ replies = <<>> /\ ~outbox
  /\ \A a \in Attempts : att[a] \notin {"pending", "waiting", "late"}

\* Once nothing is left in flight, the words of a message taken out of the queue wait somewhere.
NoLoss == (Quiescent /\ q = "dropped") => (phoneDraft \/ composerA)
=============================================================================
