
import { useState } from "react";
import LandingPage from "./components/LandingPage.jsx";

/**
 * Root UI entry point.
 *
 * This temporary analysis handler verifies that landing-page actions
 * reach the application correctly. Part 3 replaces it with the
 * actual ingestion pipeline.
 */
export default function App() {
  const [notice, setNotice] = useState("");

  function handleAnalyze(request) {
    if (request.kind === "zip") {
      setNotice(
        `"${request.file.name}" has been selected. ZIP extraction, ` +
        "local parsing, and caching will be connected in Part 3. " +
        "This selection has not uploaded the file."
      );

      return;
    }

    setNotice(
      `Validated ${request.owner}/${request.repo}. ` +
      "GitHub fetching and browser-side analysis will be connected " +
      "in Part 3. No repository source files have been fetched yet."
    );
  }

  return (
    <LandingPage
      onAnalyze={handleAnalyze}
      notice={notice}
      onDismissNotice={() => setNotice("")}
    />
  );
}
