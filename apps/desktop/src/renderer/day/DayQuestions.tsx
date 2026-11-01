import { useState } from "react";
import type { DayQuestion, DayWorkItem } from "../../shared/contracts/day";
import type { DayController } from "./controller";

function AnswerQuestion({
	item,
	question,
	controller,
	busy,
}: {
	item: DayWorkItem;
	question: DayQuestion;
	controller: DayController;
	busy: boolean;
}) {
	const [answer, setAnswer] = useState("");
	return (
		<div className="day-question">
			<p className="day-exact-text">{question.question}</p>
			<details>
				<summary>Type an answer</summary>
				<form
					className="day-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (busy || !answer.trim()) return;
						void controller
							.operate({
								kind: "answer_question",
								itemId: item.id,
								expectedRevision: item.revision,
								questionId: question.id,
								answer: answer.trim(),
							})
							.then((result) => {
								if (result) setAnswer((current) => (current === answer ? "" : current));
							});
					}}
				>
					<label>
						Your answer for MuseFocus
						<textarea
							required
							maxLength={12000}
							value={answer}
							onChange={(event) => setAnswer(event.target.value)}
						/>
					</label>
					<button type="submit" disabled={busy || !answer.trim()}>
						Save answer
					</button>
				</form>
			</details>
		</div>
	);
}

export function DayQuestions({
	item,
	controller,
	covered,
	busy,
}: {
	item: DayWorkItem;
	controller: DayController;
	covered: boolean;
	busy: boolean;
}) {
	const pending = item.questions.filter((question) => question.answer === null);
	if (!pending.length) return null;
	return (
		<section className="day-section" aria-label="Work item questions">
			<h2>Context for this item · {pending.length}</h2>
			{covered ? (
				<>
					<p className="day-hint">Answer MuseFocus in voice, or choose typing below.</p>
					{pending.map((question) => (
						<AnswerQuestion
							key={`${item.id}:${question.id}`}
							item={item}
							question={question}
							controller={controller}
							busy={busy}
						/>
					))}
				</>
			) : (
				<>
					<p className="day-hint">
						Cover this item when you’re ready to discuss the missing context.
					</p>
				</>
			)}
		</section>
	);
}
