---
title: Networking review
lang: en
---

# Sample question set for dsh-teacher

Answer keys live in HTML comments — the teacher grades against them internally and
never shows them to you.

## Q1: What happens when TCP handshake fails?
<!-- answer: The connection is not established. If SYN gets no SYN-ACK, the client retries SYN a few times (e.g. ~6 tries over ~30s), then gives up and reports connection timeout/refused. Key points: no connection is opened, retransmission of SYN, eventual timeout. -->

### hints
<!-- hint 1: Think about the three-way handshake — SYN, SYN-ACK, ACK. -->
<!-- hint 2: What does a client do when it sends SYN and hears nothing back? -->
<!-- hint 3: The client does not give up immediately. -->

## Q2: Why does rebase rewrite history?
<!-- answer: Rebase takes each commit of the branch, turns it into a patch, and replays it on top of the new base. The replayed commits are NEW commits with new hashes; the old ones remain but become unreferenced. Key point: new commits, new hashes — history is rewritten, not moved. -->

### hints
<!-- hint 1: Compare with merge — what does merge create? -->
<!-- hint 2: A commit's hash depends on its parent hashes. -->

## Q3: What is the difference between TCP and UDP?
<!-- answer: TCP is connection-oriented, reliable, ordered, with retransmission and flow/congestion control; UDP is connectionless, best-effort, unordered, with no retransmission — lower latency and overhead. Key points: reliability vs. speed, connection vs. datagram. -->
