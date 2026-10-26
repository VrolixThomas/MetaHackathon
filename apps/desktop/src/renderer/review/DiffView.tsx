import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { useReview } from "./controller";
import { referenceNotes } from "./reference-diff";

function Syntax({ text }: { text: string }) {
	if (text.trim().startsWith("//") || text.trim().startsWith("--"))
		return <span className="syntax-comment">{text}</span>;
	return (
		<>
			{text
				.split(
					/('.*?'|".*?"|\b(?:export|const|function|return|if|throw|new|await|async|for|of|import|from)\b|\b\d+\b)/g
				)
				.map((token, index) => {
					const kind = /^['"]/.test(token)
						? "string"
						: /^\d+$/.test(token)
							? "number"
							: /^(export|const|function|return|if|throw|new|await|async|for|of|import|from)$/.test(
										token
									)
								? "keyword"
								: "plain";
					return (
						<span key={`${index}-${token}`} className={`syntax-${kind}`}>
							{token}
						</span>
					);
				})}
		</>
	);
}

export function DiffView() {
	const {
		files,
		file,
		seen,
		why,
		panel,
		selection,
		openFile,
		navigate,
		markSeen,
		setWhy,
		setPanel,
	} = useReview();
	const source = files.find((f) => f.path === file) ?? files[0];
	const index = source ? files.indexOf(source) : -1;
	const scrollRef = useRef<HTMLDivElement>(null);
	const [expandedNote, setExpandedNote] = useState<string | null>(null);
	useEffect(() => {
		if (selection)
			scrollRef.current
				?.querySelector("[data-highlighted='true']")
				?.scrollIntoView({ block: "center", behavior: "smooth" });
		else scrollRef.current?.scrollTo({ top: 0 });
	}, [selection]);
	useEffect(() => {
		setExpandedNote(null);
		if (file) scrollRef.current?.scrollTo({ top: 0 });
	}, [file]);
	if (!source) return <main className="code-pane">No source is available.</main>;
	return (
		<main className={`code-pane ${panel ? "with-panel" : ""}`} aria-label="Code review">
			<header className="code-header">
				<div className="breadcrumb">
					<span>shop-web</span>
					<span className="slash">/</span>
					<span>#1284</span>
					<span className="slash">/</span>
					<strong title={file}>{file}</strong>
					<span className="diff-stats">
						<span>+{source.additions}</span> −{source.deletions}
					</span>
				</div>
				<button type="button" className="button finish-button" onClick={() => setPanel("signoff")}>
					Finish review <Icon name="arrow" size={14} />
				</button>
			</header>
			<div className="review-toolbar">
				<div className="file-nav">
					<button
						type="button"
						className="icon-button previous"
						disabled={index === 0}
						onClick={() => navigate(-1)}
						aria-label="Previous file"
					>
						<Icon name="chevron" size={14} />
					</button>
					<span>
						{index + 1} <span className="muted">of {files.length}</span>
					</span>
					<button
						type="button"
						className="icon-button"
						disabled={index === files.length - 1}
						onClick={() => navigate(1)}
						aria-label="Next file"
					>
						<Icon name="chevron" size={14} />
					</button>
					<span className="toolbar-divider" />
					<span className="file-purpose">{source.purpose}</span>
				</div>
				<div className="segmented" aria-label="Code lens">
					<button
						type="button"
						className={!why ? "active" : ""}
						aria-pressed={!why}
						onClick={() => setWhy(false)}
					>
						Plain
					</button>
					<button
						type="button"
						className={why ? "active" : ""}
						aria-pressed={why}
						onClick={() => setWhy(true)}
					>
						<Icon name="agent" size={13} /> Why
					</button>
				</div>
			</div>
			<div className={`context-strip ${selection ? "following" : ""}`}>
				<span className="dot blue" />
				<span>
					{selection ? selection.note : "One promo code + loyalty. A 40% cap. Two decisions."}
				</span>
				{!selection && <span className="attention-badge">Needs attention</span>}
			</div>
			<div className="diff-scroll" ref={scrollRef}>
				<div className="diff-file-heading">
					<Icon name="code" size={15} />
					<span>{file}</span>
					<span className="reference-label">REFERENCE EXCERPT</span>
				</div>
				<div className="diff-lines" aria-label={`Unified diff for ${file}`}>
					{source.lines.map((line) => {
						const n = selection?.side === "before" ? line.oldLine : line.newLine;
						const highlighted = !!(
							selection &&
							n &&
							n >= selection.start &&
							n <= selection.end &&
							(selection.side === "before" ? line.kind !== "add" : line.kind !== "remove")
						);
						const notes = why
							? referenceNotes.filter(
									(note) =>
										note.file === file && note.start === line.newLine && line.kind !== "remove"
								)
							: [];
						return (
							<div
								key={line.id}
								className={`diff-row-group ${highlighted ? "highlighted" : ""}`}
								data-highlighted={highlighted}
							>
								<div
									className={`diff-row ${line.kind} ${notes.some((note) => note.attention) ? "attention-line" : ""}`}
								>
									<span className="line-number">{line.oldLine ?? ""}</span>
									<span className="line-number">{line.newLine ?? ""}</span>
									<span className="line-sign" aria-label={line.kind}>
										{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
									</span>
									<code>
										<Syntax text={line.text || " "} />
									</code>
								</div>
								{notes.map((note) => (
									<div className={`why-note ${note.attention ? "warning" : ""}`} key={note.id}>
										<button
											type="button"
											onClick={() => setExpandedNote(expandedNote === note.id ? null : note.id)}
											aria-expanded={expandedNote === note.id}
										>
											<Icon name="agent" size={13} />
											<strong>{note.title}</strong>
											<span className="provenance">{note.provenance}</span>
											<span className={expandedNote === note.id ? "chevron down" : "chevron"}>
												<Icon name="chevron" size={12} />
											</span>
										</button>
										{expandedNote === note.id && <p>{note.body}</p>}
									</div>
								))}
							</div>
						);
					})}
				</div>
				<div className="end-of-file">
					<span>End of {source.path.split("/").at(-1)}</span>
					<button
						type="button"
						className={`button ${seen.includes(file) ? "checked-button" : ""}`}
						onClick={markSeen}
					>
						<Icon name="check" size={15} />
						{seen.includes(file) ? "Seen · mark unread" : "Mark as seen"}
					</button>
					{index < files.length - 1 && (
						<button
							type="button"
							className="text-button"
							onClick={() => openFile(files[index + 1]?.path ?? file)}
						>
							Next file <Icon name="arrow" size={14} />
						</button>
					)}
				</div>
			</div>
			<footer className="code-footer">
				<span>
					<span className="dot amber" /> Fixture workspace{" "}
					<span className="footer-detail">· no builds or scenarios executed</span>
				</span>
				<button
					type="button"
					className="text-button"
					onClick={() => setPanel(panel ? null : "conversation")}
				>
					<Icon name="agent" size={14} />
					{panel ? "Close agent" : "Ask about this code"}
					<kbd>esc</kbd>
				</button>
			</footer>
		</main>
	);
}
