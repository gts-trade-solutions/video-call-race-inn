"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDataChannel, useLocalParticipant } from "@livekit/components-react";
import { decodeMsg, safeSend, type Sender, useTopicSender } from "./channel";

/**
 * "Request control" / "Give control" during a screen share — the Teams
 * handshake, implemented over the room's data channel.
 *
 * What control means here: the person holding it drives a live, labelled
 * pointer on top of the shared screen that everyone (including the presenter)
 * sees, and can click to drop an attention ping. It does **not** move the
 * presenter's real mouse — no web page can inject input into someone else's
 * operating system, which is why Teams only offers true remote control from its
 * native desktop app. The presenter stays in charge and can take control back
 * at any moment.
 *
 * The presenter is the source of truth: only messages coming from their
 * identity may change who holds control, and only the holder's pointer moves.
 */

type ControlMsg =
  | { t: "request" }
  | { t: "grant"; identity: string }
  | { t: "deny"; identity: string }
  | { t: "revoke" }
  | { t: "release" }
  | { t: "sync" }
  | { t: "state"; controller: string | null }
  | { t: "cursor"; x: number; y: number }
  | { t: "click"; x: number; y: number };

export type SharePointer = { identity: string; x: number; y: number };

export type UseShareControl = {
  /** Identity currently holding control, or null. */
  controller: string | null;
  /** Identities waiting on the presenter's answer (presenter only). */
  requests: string[];
  amController: boolean;
  amPresenter: boolean;
  /** We've asked and haven't heard back yet. */
  requestPending: boolean;
  requestControl: () => void;
  grantControl: (identity: string) => void;
  denyControl: (identity: string) => void;
  /** Presenter pulls control back. */
  revokeControl: () => void;
  /** Controller gives control back voluntarily. */
  releaseControl: () => void;
  /** Live pointer of the controller, in 0..1 coordinates of the shared video. */
  pointer: SharePointer | null;
  /** Click ripples to render, in 0..1 coordinates. */
  pings: { id: number; x: number; y: number }[];
  moveCursor: (x: number, y: number) => void;
  clickAt: (x: number, y: number) => void;
};

/** Cursor updates are lossy and rate-limited — 25/s is smooth and cheap. */
const CURSOR_INTERVAL_MS = 40;

export function useShareControl(opts: {
  /** Identity of whoever is screen-sharing right now, or null. */
  presenterIdentity: string | null;
  /** Fired for the request/grant/deny notifications. */
  onNotice?: (text: string) => void;
}): UseShareControl {
  const { localParticipant } = useLocalParticipant();
  const me = localParticipant?.identity ?? "";
  const presenter = opts.presenterIdentity;
  const amPresenter = !!presenter && presenter === me;

  const [controller, setController] = useState<string | null>(null);
  const [requests, setRequests] = useState<string[]>([]);
  const [requestPending, setRequestPending] = useState(false);
  const [pointer, setPointer] = useState<SharePointer | null>(null);
  const [pings, setPings] = useState<{ id: number; x: number; y: number }[]>([]);

  const sendRef = useRef<Sender | null>(null);
  const controllerRef = useRef<string | null>(null);
  controllerRef.current = controller;
  const meRef = useRef(me);
  meRef.current = me;
  const presenterRef = useRef(presenter);
  presenterRef.current = presenter;
  const amPresenterRef = useRef(amPresenter);
  amPresenterRef.current = amPresenter;
  const onNoticeRef = useRef(opts.onNotice);
  onNoticeRef.current = opts.onNotice;
  const lastCursorRef = useRef(0);
  const pingSeq = useRef(0);

  const addPing = useCallback((x: number, y: number) => {
    const id = ++pingSeq.current;
    setPings((p) => [...p, { id, x, y }]);
    setTimeout(() => setPings((p) => p.filter((i) => i.id !== id)), 1200);
  }, []);

  const send = useTopicSender("control");
  useDataChannel("control", (msg) => {
    const from = msg.from?.identity;
    if (!from) return;
    const d = decodeMsg<ControlMsg>(msg.payload);
    if (!d) return;

    switch (d.t) {
      case "request":
        // Only the presenter decides, so only they collect the queue.
        if (!amPresenterRef.current) return;
        setRequests((r) => (r.includes(from) ? r : [...r, from]));
        onNoticeRef.current?.(`${msg.from?.name || from} is requesting control`);
        break;

      case "grant":
        if (from !== presenterRef.current) return; // only the presenter grants
        setController(d.identity);
        setRequests((r) => r.filter((i) => i !== d.identity));
        if (d.identity === meRef.current) {
          setRequestPending(false);
          onNoticeRef.current?.("You have control of the shared screen");
        }
        break;

      case "deny":
        if (from !== presenterRef.current) return;
        setRequests((r) => r.filter((i) => i !== d.identity));
        if (d.identity === meRef.current) {
          setRequestPending(false);
          onNoticeRef.current?.("Your request for control was declined");
        }
        break;

      case "revoke":
        if (from !== presenterRef.current) return;
        if (controllerRef.current === meRef.current) {
          onNoticeRef.current?.("The presenter took control back");
        }
        setController(null);
        setPointer(null);
        break;

      case "release":
        // Whoever holds control may hand it back.
        if (from !== controllerRef.current) return;
        setController(null);
        setPointer(null);
        break;

      case "sync":
        // Only the presenter can answer authoritatively.
        if (!amPresenterRef.current) return;
        safeSend(sendRef.current, {
          t: "state",
          controller: controllerRef.current,
        } satisfies ControlMsg);
        break;

      case "state":
        if (from !== presenterRef.current) return;
        setController(d.controller ?? null);
        break;

      case "cursor":
        if (from !== controllerRef.current) return;
        setPointer({ identity: from, x: d.x, y: d.y });
        break;

      case "click":
        if (from !== controllerRef.current) return;
        addPing(d.x, d.y);
        break;
    }
  });
  sendRef.current = send;

  // A new share (or none) resets everything: control never carries over from
  // one presentation to the next.
  useEffect(() => {
    setController(null);
    setRequests([]);
    setRequestPending(false);
    setPointer(null);
    if (!presenter || presenter === meRef.current) return;
    const ask = () => safeSend(sendRef.current, { t: "sync" } satisfies ControlMsg);
    const t1 = setTimeout(ask, 500);
    const t2 = setTimeout(ask, 2200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [presenter]);

  const requestControl = useCallback(() => {
    if (!presenterRef.current || amPresenterRef.current) return;
    setRequestPending(true);
    safeSend(sendRef.current, { t: "request" } satisfies ControlMsg, {
      destinationIdentities: [presenterRef.current],
    });
    // A presenter who never answers shouldn't leave the button stuck on
    // "Asked…" for the rest of the call — let them ask again after a while.
    setTimeout(() => setRequestPending(false), 30_000);
  }, []);

  const grantControl = useCallback((identity: string) => {
    if (!amPresenterRef.current) return;
    setController(identity);
    setRequests((r) => r.filter((i) => i !== identity));
    safeSend(sendRef.current, { t: "grant", identity } satisfies ControlMsg);
  }, []);

  const denyControl = useCallback((identity: string) => {
    if (!amPresenterRef.current) return;
    setRequests((r) => r.filter((i) => i !== identity));
    safeSend(sendRef.current, { t: "deny", identity } satisfies ControlMsg);
  }, []);

  const revokeControl = useCallback(() => {
    if (!amPresenterRef.current) return;
    setController(null);
    setPointer(null);
    safeSend(sendRef.current, { t: "revoke" } satisfies ControlMsg);
  }, []);

  const releaseControl = useCallback(() => {
    if (controllerRef.current !== meRef.current) return;
    setController(null);
    setPointer(null);
    safeSend(sendRef.current, { t: "release" } satisfies ControlMsg);
  }, []);

  const moveCursor = useCallback((x: number, y: number) => {
    if (controllerRef.current !== meRef.current) return;
    const now = Date.now();
    if (now - lastCursorRef.current < CURSOR_INTERVAL_MS) return;
    lastCursorRef.current = now;
    setPointer({ identity: meRef.current, x, y });
    // Lossy: a dropped cursor frame is replaced 40ms later anyway, and this
    // keeps pointer traffic off the reliable channel that chat/hands use.
    safeSend(sendRef.current, { t: "cursor", x, y } satisfies ControlMsg, {
      reliable: false,
    });
  }, []);

  const clickAt = useCallback(
    (x: number, y: number) => {
      if (controllerRef.current !== meRef.current) return;
      addPing(x, y);
      safeSend(sendRef.current, { t: "click", x, y } satisfies ControlMsg);
    },
    [addPing]
  );

  return {
    controller,
    requests,
    amController: !!controller && controller === me,
    amPresenter,
    requestPending,
    requestControl,
    grantControl,
    denyControl,
    revokeControl,
    releaseControl,
    pointer,
    pings,
    moveCursor,
    clickAt,
  };
}
