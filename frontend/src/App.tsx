import { useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow } from "@xyflow/react";
import type { Node, NodeProps, Edge } from "@xyflow/react";
import {
  createPlan, Diagnosis, ExecutionResult, getExecution, getRecovery, NodeStatus, RecoveryResult, startExecution, startRecovery, waitFor,
  WorkflowNode, WorkflowPlan,
} from "./api";

type GraphNodeData = { node: WorkflowNode; status?: NodeStatus; output?: unknown };
type GraphNode = Node<GraphNodeData, "aegis">;

const statusLabels: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  skipped: "Skipped",
};

function AegisNode({ data }: NodeProps<GraphNode>) {
  const status = data.status ?? "pending";
  return (
    <div className={`flow-node flow-${status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-topline"><span className={`type-dot type-${data.node.type}`} />{data.node.type}</div>
      <strong>{data.node.title}</strong>
      <span className="node-id">{data.node.id}</span>
      <span className="node-status">{statusLabels[status]}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { aegis: AegisNode };

function graphFor(plan: WorkflowPlan | undefined, result?: ExecutionResult): { nodes: GraphNode[]; edges: Edge[] } {
  if (!plan) return { nodes: [], edges: [] };
  const levels = new Map<string, number>();
  const levelOf = (node: WorkflowNode): number => {
    if (levels.has(node.id)) return levels.get(node.id)!;
    const level = node.dependencies.length ? Math.max(...node.dependencies.map((dependency) => levelOf(plan.nodes.find((candidate) => candidate.id === dependency)!))) + 1 : 0;
    levels.set(node.id, level);
    return level;
  };
  plan.nodes.forEach(levelOf);
  const columns = new Map<number, number>();
  const nodes = plan.nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const column = columns.get(level) ?? 0;
    columns.set(level, column + 1);
    const execution = result?.nodes[node.id];
    return {
      id: node.id,
      type: "aegis",
      position: { x: level * 280, y: column * 125 },
      data: { node, status: execution?.status, output: execution?.output },
    } satisfies GraphNode;
  });
  const edges = plan.nodes.flatMap((node) => node.dependencies.map((dependency) => ({
    id: `${dependency}-${node.id}`,
    source: dependency,
    target: node.id,
    animated: result?.nodes[node.id]?.status === "running",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#61708e" },
  })));
  return { nodes, edges };
}

function findDiagnosis(result?: ExecutionResult): Diagnosis | undefined {
  return result ? Object.values(result.nodes).find((node) => node.diagnosis)?.diagnosis : undefined;
}

function findSafetyDecision(result?: ExecutionResult) {
  if (!result) return undefined;
  return Object.values(result.outputs).find((output) => typeof output === "object" && output !== null && "allowed" in output && "policyRuleId" in output) as { allowed: boolean; reason: string; policyRuleId: string; action: { type: string } } | undefined;
}

function formatOutput(value: unknown): string {
  if (value === undefined) return "No output recorded";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function App() {
  const [objective, setObjective] = useState("");
  const [plan, setPlan] = useState<WorkflowPlan>();
  const [execution, setExecution] = useState<ExecutionResult>();
  const [recovery, setRecovery] = useState<RecoveryResult>();
  const [selectedAttempt, setSelectedAttempt] = useState(0);
  const [history, setHistory] = useState<Array<{ kind: "execution" | "recovery"; id: string; status: string }>>([]);
  const [busy, setBusy] = useState<"plan" | "execute" | "recover" | null>(null);
  const [error, setError] = useState<string>();

  const selectedWorkflow = recovery?.attempts[selectedAttempt]?.workflow ?? plan;
  const selectedResult = recovery?.attempts[selectedAttempt]?.result ?? execution;
  const graph = useMemo(() => graphFor(selectedWorkflow, selectedResult), [selectedWorkflow, selectedResult]);
  const diagnosis = findDiagnosis(selectedResult);
  const safety = findSafetyDecision(selectedResult);
  const latestAttempt = recovery?.attempts[recovery.attempts.length - 1];
  const diff = recovery && selectedAttempt > 0 ? recovery.attempts[selectedAttempt - 1]?.diff ?? recovery.attempts[selectedAttempt - 1]?.proposal : undefined;

  const reset = () => {
    setPlan(undefined); setExecution(undefined); setRecovery(undefined); setError(undefined); setSelectedAttempt(0);
  };

  const handlePlan = async () => {
    if (!objective.trim()) return setError("Enter an objective before planning.");
    setBusy("plan"); setError(undefined); setExecution(undefined); setRecovery(undefined);
    try { setPlan(await createPlan(objective.trim())); } catch (caught) { setError(caught instanceof Error ? caught.message : "Planning failed."); }
    finally { setBusy(null); }
  };

  const handleExecute = async () => {
    if (!plan) return;
    setBusy("execute"); setError(undefined); setRecovery(undefined);
    try {
      const queued = await startExecution(plan);
      setHistory((items) => [{ kind: "execution", id: queued.executionId, status: queued.status }, ...items.filter((item) => item.id !== queued.executionId)]);
      const snapshot = await waitFor(() => getExecution(queued.executionId), (value) => ["completed", "failed"].includes(value.status));
      if (snapshot.result) setExecution(snapshot.result);
      setHistory((items) => items.map((item) => item.id === queued.executionId ? { ...item, status: snapshot.status } : item));
      if (snapshot.error) setError(snapshot.error);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Execution failed."); }
    finally { setBusy(null); }
  };

  const handleRecover = async () => {
    if (!plan || !execution || execution.status === "succeeded") return;
    setBusy("recover"); setError(undefined);
    try {
      const queued = await startRecovery(plan, { supportedRecheckType: "research" });
      setHistory((items) => [{ kind: "recovery", id: queued.recoveryId, status: queued.status }, ...items.filter((item) => item.id !== queued.recoveryId)]);
      const snapshot = await waitFor(() => getRecovery(queued.recoveryId), (value) => ["completed", "failed"].includes(value.status));
      if (snapshot.result) {
        setRecovery(snapshot.result); setSelectedAttempt(snapshot.result.attempts.length - 1);
        setExecution(snapshot.result.attempts[snapshot.result.attempts.length - 1]?.result);
      }
      setHistory((items) => items.map((item) => item.id === queued.recoveryId ? { ...item, status: snapshot.status } : item));
      if (snapshot.error) setError(snapshot.error);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Recovery failed."); }
    finally { setBusy(null); }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">A</div><div><span className="eyebrow">AUTONOMOUS OPERATIONS</span><h1>AEGIS</h1></div></div>
        <div className="topbar-meta"><span className="live-dot" /> <span>CONTROL CENTER</span><span className="version">v1 / proposal-safe</span></div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy"><span className="eyebrow cyan">MISSION CONTROL / WORKFLOW INTELLIGENCE</span><h2>Turn an objective into<br /><em>observable action.</em></h2><p>Plan, inspect, execute, and recover with every decision surfaced. AEGIS never hides a blocked action or claims an unverified result.</p></div>
        <div className="goal-card"><div className="section-kicker"><span className="step">01</span> DEFINE OBJECTIVE</div><textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What should AEGIS accomplish?" rows={3} /><div className="goal-actions"><button className="button primary" onClick={handlePlan} disabled={busy !== null}>{busy === "plan" ? "Planning…" : "Generate plan  ↗"}</button><button className="button ghost" onClick={reset}>Reset</button></div></div>
      </section>

      {error && <div className="alert error"><strong>Backend signal</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}

      <section className="stat-strip">
        <div><span>WORKFLOW VERSION</span><strong>{selectedWorkflow ? `v${selectedWorkflow.version}` : "—"}</strong></div>
        <div><span>NODES</span><strong>{selectedWorkflow?.nodes.length ?? "—"}</strong></div>
        <div><span>EXECUTION</span><strong className={selectedResult?.status === "succeeded" ? "success-text" : selectedResult?.status === "failed" ? "danger-text" : ""}>{selectedResult ? selectedResult.status.toUpperCase() : "IDLE"}</strong></div>
        <div><span>RECOVERY</span><strong>{recovery ? `${recovery.attempts.length} ATTEMPT${recovery.attempts.length === 1 ? "" : "S"}` : "NOT STARTED"}</strong></div>
        <div className="stat-action"><button className="button primary compact" onClick={handleExecute} disabled={!plan || busy !== null}>{busy === "execute" ? "Executing…" : "Execute workflow  ▶"}</button></div>
      </section>

      <section className="workspace-grid">
        <div className="panel graph-panel"><div className="panel-header"><div><span className="eyebrow">LIVE TOPOLOGY</span><h3>Workflow graph</h3></div><span className="badge">{selectedWorkflow ? `VERSION ${selectedWorkflow.version}` : "AWAITING PLAN"}</span></div>{selectedWorkflow ? <div className="graph-canvas"><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}><Background color="#1d2b42" gap={22} /><MiniMap nodeColor={(node) => node.data?.status === "succeeded" ? "#48d6aa" : node.data?.status === "failed" ? "#ff6b7a" : "#3f526d"} /><Controls /></ReactFlow></div> : <EmptyState title="No workflow loaded" body="Generate a plan to see dependencies, agents, and execution state here." />}</div>
        <div className="side-stack"><SafetyPanel decision={safety} /><DiagnosisPanel diagnosis={diagnosis} /><RecoveryPanel recovery={recovery} selectedAttempt={selectedAttempt} onSelectAttempt={setSelectedAttempt} busy={busy === "recover"} canRecover={Boolean(execution && execution.status === "failed")} onRecover={handleRecover} /> </div>
      </section>

      <section className="lower-grid"><Timeline result={selectedResult} recovery={recovery} /><DiffPanel diff={diff} /></section>
      <section className="history-panel panel"><div className="panel-header"><div><span className="eyebrow">PERSISTED SIGNALS</span><h3>Execution history</h3></div><span className="muted">Session IDs are read from the SQLite-backed API</span></div>{history.length ? <div className="history-list">{history.map((item) => <div className="history-row" key={item.id}><span className={`history-icon ${item.kind}`}>{item.kind === "recovery" ? "↻" : "▶"}</span><div><strong>{item.kind === "recovery" ? "Recovery run" : "Execution"}</strong><span>{item.id}</span></div><span className={`status-pill status-${item.status}`}>{item.status}</span></div>)}</div> : <EmptyState title="No persisted runs in this session" body="Execute a planned workflow to create a backend history record." />}</section>
      <footer><span>AEGIS / SAFE AUTONOMY LAYER</span><span>Backend: {import.meta.env.VITE_API_BASE_URL || "Vite proxy → localhost:3000"}</span></footer>
    </main>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) { return <div className="empty-state"><div className="empty-orbit">◎</div><strong>{title}</strong><span>{body}</span></div>; }

function SafetyPanel({ decision }: { decision?: ReturnType<typeof findSafetyDecision> }) {
  return <div className="panel compact-panel"><div className="panel-header"><div><span className="eyebrow">POLICY ENFORCEMENT</span><h3>Safety Gate</h3></div><span className={`decision ${decision ? decision.allowed ? "allowed" : "blocked" : "unknown"}`}>{decision ? decision.allowed ? "ALLOW" : "BLOCK" : "NO DECISION"}</span></div>{decision ? <><div className="decision-card"><strong>{decision.action.type}</strong><span>{decision.reason}</span></div><div className="rule-id">RULE / {decision.policyRuleId}</div></> : <p className="muted">A real gate decision appears when an execution evaluates an action. Nothing is inferred from planner text.</p>}</div>;
}

function DiagnosisPanel({ diagnosis }: { diagnosis?: Diagnosis }) {
  return <div className="panel compact-panel"><div className="panel-header"><div><span className="eyebrow">FAILURE ANALYSIS</span><h3>Diagnostician</h3></div>{diagnosis && <span className="category-badge">{diagnosis.category.replaceAll("_", " ")}</span>}</div>{diagnosis ? <><p className="diagnosis-reason">{diagnosis.reason}</p><div className="evidence-list">{diagnosis.evidence.map((item) => <div key={item}><span>+</span>{item}</div>)}</div><div className="diagnosis-footer"><span>RETRYABLE</span><strong className={diagnosis.retryable ? "success-text" : "danger-text"}>{diagnosis.retryable ? "YES" : "NO"}</strong></div></> : <p className="muted">No diagnosis has been recorded for the current result.</p>}</div>;
}

function RecoveryPanel({ recovery, selectedAttempt, onSelectAttempt, busy, canRecover, onRecover }: { recovery?: RecoveryResult; selectedAttempt: number; onSelectAttempt: (attempt: number) => void; busy: boolean; canRecover: boolean; onRecover: () => void }) {
  return <div className="panel compact-panel recovery-panel"><div className="panel-header"><div><span className="eyebrow">BOUNDED SELF-HEALING</span><h3>Recovery loop</h3></div>{recovery && <span className={`status-pill status-${recovery.status}`}>{recovery.status}</span>}</div>{recovery ? <><div className="attempt-strip">{recovery.attempts.map((attempt, index) => <button className={index === selectedAttempt ? "selected" : ""} key={attempt.attempt} onClick={() => onSelectAttempt(index)}><span>ATTEMPT {attempt.attempt}</span><strong>v{attempt.workflowVersion}</strong><small>{attempt.outcome}</small></button>)}</div><div className="stop-reason"><span>STOP REASON</span><strong>{recovery.stopReason.replaceAll("_", " ")}</strong></div></> : <p className="muted">Recovery is proposal-driven and never automatic from this panel.</p>}<button className="button outline full" disabled={!canRecover || busy} onClick={onRecover}>{busy ? "Recovering…" : canRecover ? "Propose & run bounded recovery  ↻" : "Recovery unavailable until a failure"}</button></div>;
}

function Timeline({ result, recovery }: { result?: ExecutionResult; recovery?: RecoveryResult }) {
  const attempts: Array<{ attempt: number; result: ExecutionResult; workflowVersion: number; outcome: "succeeded" | "failed" }> = recovery?.attempts ?? (result ? [{ attempt: 0, result, workflowVersion: 1, outcome: result.status }] : []);
  return <div className="panel timeline-panel"><div className="panel-header"><div><span className="eyebrow">EXECUTION TRACE</span><h3>Timeline</h3></div><span className="muted">{attempts.length ? `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}` : "No events"}</span></div>{attempts.length ? <div className="timeline">{attempts.map((attempt) => <div className="timeline-item" key={attempt.attempt}><div className="timeline-marker">{attempt.outcome === "succeeded" ? "✓" : "!"}</div><div className="timeline-content"><div className="timeline-title"><strong>Attempt {attempt.attempt} / workflow v{attempt.workflowVersion}</strong><span className={`status-pill status-${attempt.outcome}`}>{attempt.outcome}</span></div><span className="muted">{Object.entries(attempt.result.nodes).map(([id, node]) => `${id}: ${node.status}`).join("  ·  ")}</span>{attempt.result.nodes && Object.values(attempt.result.nodes).some((node) => node.error) && <pre>{Object.values(attempt.result.nodes).map((node) => node.error).filter(Boolean).join("\n")}</pre>}</div></div>)}</div> : <EmptyState title="Timeline is quiet" body="Run a workflow to inspect actual agent outcomes." />}</div>;
}

function DiffPanel({ diff }: { diff?: { changes: Array<{ type: string; nodeId: string; explanation: string; before?: unknown; after?: unknown }> } }) {
  return <div className="panel diff-panel"><div className="panel-header"><div><span className="eyebrow">AUDITABLE REVISION</span><h3>v1 → v2 diff</h3></div><span className="badge">{diff ? `${diff.changes.length} CHANGE${diff.changes.length === 1 ? "" : "S"}` : "NO REVISION"}</span></div>{diff?.changes.length ? <div className="diff-list">{diff.changes.map((change, index) => <div className="diff-row" key={`${change.nodeId}-${index}`}><span className={`diff-type diff-${change.type}`}>{change.type.replaceAll("_", " ")}</span><div><strong>{change.nodeId}</strong><span>{change.explanation}</span></div></div>)}</div> : <EmptyState title="No revision proposed" body="A diff appears only when the real Architect returns a validated workflow revision." />}</div>;
}
