import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { externalWebUrl } from "../../../../shared/links";
import styles from "./MarkdownAnswer.module.css";

export function MarkdownAnswer({ children }: { children: string }) {
  const [linkError, setLinkError] = useState(false);
  return (
    <div className={styles.markdown}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const url = externalWebUrl(href);
            if (!url) return <span>{children}</span>;
            return (
              <a
                href={url}
                title={url}
                onClick={(event) => {
                  event.preventDefault();
                  setLinkError(false);
                  void window.workspace
                    .openExternalLink(url)
                    .catch(() => setLinkError(true));
                }}
              >
                {children}
              </a>
            );
          },
          // Answers are text: do not fetch remote images from model output.
          img: ({ alt }) => (alt ? <span>{alt}</span> : null),
          table: ({ children }) => (
            <div className={styles.table}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
      {linkError && (
        <p className={styles.error} role="alert">
          Could not open the link in your browser.
        </p>
      )}
    </div>
  );
}
