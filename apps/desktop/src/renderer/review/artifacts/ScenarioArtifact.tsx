import { Fragment, useEffect, useRef, useState } from "react";
import type { ScenarioRun, ScenarioStep, ScenarioTrace } from "../../../shared/contracts";
import { Icon } from "../Icons";
import {
	type ScenarioRevision,
	scenarioLocation,
	scenarioRows,
	scenarioStepAt,
	scenarioValue,
	selectedScenarioIndex,
} from "./scenario-model";
import "./scenario.css";

export type ScenarioArtifactProps = {
	trace: ScenarioTrace;
	selectedIndex: number;
	onSelect: (step: ScenarioStep, index: number) => void;
	onKeepAsTest?: () => Promise<void>;
	onDraftComment?: () => void;
};

function Values({ values }: { values: ScenarioStep["values"] }) {
	const entries = Object.entries(values);
	if (!entries.length) return <span className="scenario-values-empty">No values captured</span>;
	return (
		<span className="scenario-values">
			{entries.map(([key, value]) => (
				<span key={key}>
					<span className="scenario-value-key">{key}</span> = {scenarioValue(value)}
				</span>
			))}
		</span>
	);
}

function Evidence({ run, label }: { run: ScenarioRun; label: string }) {
	return (
		<details className="scenario-evidence">
			<summary>
				{label} ·{" "}
				{run.evidence.kind === "fixture" ? "fixture, not executed" : `executed · ${run.status}`}
			</summary>
			<dl>
				<dt>Revision</dt>
				<dd>
					<code>
						{run.revision} · {run.commitSha}
					</code>
				</dd>
				<dt>Trace status</dt>
				<dd>
					{run.status}
					{run.evidence.kind === "fixture" ? " (illustrative)" : ""}
				</dd>
				{run.evidence.kind === "fixture" ? (
					<>
						<dt>Evidence</dt>
						<dd>{run.evidence.label}</dd>
					</>
				) : (
					<>
						<dt>Run ID</dt>
						<dd>{run.evidence.runId}</dd>
						<dt>Command</dt>
						<dd>
							<code>{run.evidence.command.join(" ")}</code>
						</dd>
						<dt>Exit code</dt>
						<dd>{run.evidence.exitCode}</dd>
						<dt>Completed</dt>
						<dd>{run.evidence.completedAt}</dd>
					</>
				)}
			</dl>
		</details>
	);
}

function StepCard({
	step,
	label,
	selected,
	onSelect,
}: { step: ScenarioStep | undefined; label: string; selected: boolean; onSelect: () => void }) {
	if (!step)
		return (
			<div className="scenario-card scenario-missing">
				<span>No step recorded</span>
				<span className="scenario-source">{label} has no trace entry here.</span>
			</div>
		);
	return (
		<button
			type="button"
			className={`scenario-card ${step.outcome === "throw" || step.outcome === "stopped" ? "scenario-warning" : ""}`}
			onClick={onSelect}
			aria-label={`${label}: ${step.label}; ${scenarioLocation(step)}`}
			aria-current={selected ? "step" : undefined}
		>
			<strong>{step.label}</strong>
			<span className="scenario-source">{scenarioLocation(step)}</span>
			<Values values={step.values} />
			<span className="scenario-outcome">{step.outcome}</span>
		</button>
	);
}

export function ScenarioArtifact({
	trace,
	selectedIndex,
	onSelect,
	onKeepAsTest,
	onDraftComment,
}: ScenarioArtifactProps) {
	const rows = scenarioRows(trace);
	const current = selectedScenarioIndex(selectedIndex, rows.length);
	const rowList = useRef<HTMLOListElement>(null);
	const [preferredRevision, setPreferredRevision] = useState<ScenarioRevision>("head");
	const [saving, setSaving] = useState<{ key: string; state: "saving" | "saved" | "error" } | null>(
		null
	);
	const traceKey = `${trace.id}:${trace.before.commitSha}:${trace.after.commitSha}`;
	const activeTrace = useRef(traceKey);
	activeTrace.current = traceKey;
	const saveState = saving?.key === traceKey ? saving.state : null;
	useEffect(() => {
		const list = rowList.current;
		const row = list?.querySelector<HTMLElement>(`[data-scenario-index="${current}"]`);
		if (!list || !row) return;
		const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
		if (offset < 0) list.scrollTop += offset;
		else if (offset + row.offsetHeight > list.clientHeight) {
			list.scrollTop += offset + row.offsetHeight - list.clientHeight;
		}
	}, [current]);
	const select = (step: ScenarioStep | undefined, index: number) => {
		if (!step) return;
		setPreferredRevision(step.location.revision);
		onSelect(step, index);
	};
	const move = (delta: number) => {
		if (current === null) return;
		const index = current + delta;
		if (index < 0 || index >= rows.length) return;
		select(scenarioStepAt(trace, index, preferredRevision), index);
	};
	const saveTest = async () => {
		if (!onKeepAsTest || saveState === "saving") return;
		setSaving({ key: traceKey, state: "saving" });
		try {
			await onKeepAsTest();
			if (activeTrace.current === traceKey) setSaving({ key: traceKey, state: "saved" });
		} catch {
			if (activeTrace.current === traceKey) setSaving({ key: traceKey, state: "error" });
		}
	};
	return (
		<section className="scenario-artifact" aria-label={trace.title}>
			<p className="scenario-origin">
				{trace.before.evidence.kind === "fixture" && trace.after.evidence.kind === "fixture"
					? "Illustrative fixture · not executed"
					: trace.before.evidence.kind === "fixture" || trace.after.evidence.kind === "fixture"
						? "Mixed evidence · includes unexecuted fixture data"
						: "Execution evidence available for both revisions"}
			</p>
			<div className="scenario-inputs" aria-label="Scenario inputs">
				{Object.entries(trace.inputs).map(([key, value]) => (
					<span key={key}>
						<span>{key}</span> {scenarioValue(value)}
					</span>
				))}
			</div>
			<div className="scenario-lane-headings">
				<span>
					Before this PR <code>{trace.before.commitSha.slice(0, 7)}</code>
				</span>
				<span>
					This PR <code>{trace.after.commitSha.slice(0, 7)}</code>
				</span>
			</div>
			{trace.divergenceIndex === undefined && (
				<p className="scenario-notice">No divergence point was identified in this trace.</p>
			)}
			{rows.length === 0 ? (
				<p className="scenario-notice">
					No steps were recorded. Inspect the run evidence below before drawing a conclusion.
				</p>
			) : (
				<ol className="scenario-rows" ref={rowList}>
					{rows.map((row) => (
						<Fragment key={row.index}>
							{row.divergesHere && (
								<li className="scenario-split">
									<span>The paths split here</span>
								</li>
							)}
							<li
								className={`scenario-row ${row.index === current ? "scenario-current" : ""}`}
								data-scenario-index={row.index}
								aria-label={`Step ${row.index + 1}`}
							>
								<span className="scenario-number" aria-hidden="true">
									{row.index + 1}
								</span>
								{row.shared && row.before && row.after ? (
									<div className="scenario-shared">
										<strong>{row.after.label}</strong>
										<Values values={row.after.values} />
										<div className="scenario-source-pair">
											<button
												type="button"
												onClick={() => select(row.before, row.index)}
												aria-label={`Before this PR: ${row.before.label}; ${scenarioLocation(row.before)}`}
												aria-current={
													row.index === current && preferredRevision === "base" ? "step" : undefined
												}
											>
												Before · <code>{scenarioLocation(row.before)}</code>
											</button>
											<button
												type="button"
												onClick={() => select(row.after, row.index)}
												aria-label={`This PR: ${row.after.label}; ${scenarioLocation(row.after)}`}
												aria-current={
													row.index === current && preferredRevision === "head" ? "step" : undefined
												}
											>
												This PR · <code>{scenarioLocation(row.after)}</code>
											</button>
										</div>
									</div>
								) : (
									<div className="scenario-lanes">
										<StepCard
											step={row.before}
											label="Before this PR"
											selected={row.index === current && preferredRevision === "base"}
											onSelect={() => select(row.before, row.index)}
										/>
										<StepCard
											step={row.after}
											label="This PR"
											selected={row.index === current && preferredRevision === "head"}
											onSelect={() => select(row.after, row.index)}
										/>
									</div>
								)}
							</li>
						</Fragment>
					))}
				</ol>
			)}
			<div className="scenario-controls">
				<button
					type="button"
					className="button previous"
					aria-label="Previous scenario step"
					disabled={current === null || current === 0}
					onClick={() => move(-1)}
				>
					<Icon name="chevron" size={14} />
				</button>
				<span aria-live="polite">
					{current === null ? "No steps" : `Step ${current + 1} of ${rows.length}`}
				</span>
				<button
					type="button"
					className="button"
					aria-label="Next scenario step"
					disabled={current === null || current === rows.length - 1}
					onClick={() => move(1)}
				>
					<Icon name="chevron" size={14} />
				</button>
			</div>
			<div className="scenario-actions">
				<button
					type="button"
					className="button primary"
					disabled={!onKeepAsTest || saveState === "saving"}
					onClick={() => void saveTest()}
				>
					{saveState === "saving" ? "Saving…" : "Keep as a test"}
				</button>
				<button
					type="button"
					className="button"
					disabled={!onDraftComment || current === null}
					onClick={onDraftComment}
				>
					Draft comment
				</button>
			</div>
			{!onKeepAsTest && (
				<p className="scenario-notice">
					Test saving needs a runtime connection. This view does not run or save a test.
				</p>
			)}
			{saveState === "saved" && (
				<output className="scenario-feedback">
					Saved as a test. Execution results are separate.
				</output>
			)}
			{saveState === "error" && (
				<output className="scenario-feedback">The test could not be saved. Try again.</output>
			)}
			<div className="scenario-evidence-list">
				<Evidence run={trace.before} label="Before" />
				<Evidence run={trace.after} label="This PR" />
			</div>
		</section>
	);
}
