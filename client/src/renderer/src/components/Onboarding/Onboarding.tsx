import { ArrowLeft, ArrowRight, Library } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../Dialog/Dialog";
import styles from "./Onboarding.module.css";
import { markOnboardingSeen } from "./onboarding-state";
import { tourSteps } from "./steps";
import { TourSandbox } from "./TourSandbox";
import { TourVersions } from "./TourVersions";

export function Onboarding({
  onClose,
  onExamples,
}: {
  onClose: () => void;
  onExamples: () => void;
}) {
  const web = window.workspace.platform === "web";
  const steps = tourSteps(web);
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLElement>(null);
  const last = index === steps.length - 1;
  useEffect(markOnboardingSeen, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each chapter change must reset focus and scroll.
  useEffect(() => {
    // Move keyboard and screen-reader focus into the newly selected chapter.
    heading.current?.focus({ preventScroll: true });
    content.current?.scrollTo(0, 0);
  }, [index]);
  return (
    <Dialog title="Welcome to Wien" className={styles.dialog} onClose={onClose}>
      <div className={styles.layout}>
        <nav className={styles.chapters} aria-label="Tour chapters">
          <span className={styles.eyebrow}>A quick tour</span>
          {steps.map((item, position) => (
            <button
              type="button"
              key={item.id}
              aria-current={position === index ? "step" : undefined}
              onClick={() => setIndex(position)}
            >
              <item.icon size={16} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <section
          ref={content}
          className={styles.content}
          aria-labelledby="tour-heading"
        >
          <div className={styles.stepLabel}>
            0{index + 1} / 0{steps.length}
          </div>
          <h3 id="tour-heading" ref={heading} tabIndex={-1}>
            {step.title}
          </h3>
          {step.description && (
            <p className={styles.description}>{step.description}</p>
          )}
          {step.id === "save" ? (
            <TourVersions />
          ) : (
            step.id !== "wav" && <TourSandbox key={step.id} topic={step.id} />
          )}
          <ol className={styles.instructions}>
            {step.instructions.map((instruction) => (
              <li key={instruction.title}>
                <strong>{instruction.title}</strong>
                <p>{instruction.body}</p>
              </li>
            ))}
          </ol>
          {step.tip && <p className={styles.tip}>{step.tip}</p>}
        </section>
      </div>
      <footer className={styles.footer}>
        <span className={styles.counter} aria-live="polite">
          {index + 1} of {steps.length}
        </span>
        <div className={styles.actions}>
          {index > 0 && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIndex(index - 1)}
            >
              <ArrowLeft size={14} /> Back
            </button>
          )}
          {last && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onExamples}
            >
              <Library size={14} /> Browse examples
            </button>
          )}
          <button
            type="button"
            className={styles.primaryButton}
            onClick={last ? onClose : () => setIndex(index + 1)}
          >
            {last ? "Let’s make something" : "Next"}
            <ArrowRight size={14} />
          </button>
        </div>
      </footer>
    </Dialog>
  );
}
