/**
 * Application-wide React error boundary.
 *
 * WHY: A rendering failure should result in a useful recovery screen,
 * not a blank page that hides the underlying problem.
 */

import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      hasError: false,
      error: null
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error
    };
  }

  componentDidCatch(error, info) {
    console.error(
      "Astral Atlas encountered a rendering error.",
      error,
      info.componentStack
    );
  }

  handleRecovery = () => {
    this.setState({
      hasError: false,
      error: null
    });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main className="aa-fatal-error">
        <p className="aa-eyebrow">ASTRAL ATLAS / RECOVERY</p>

        <h1>The atlas lost its bearings.</h1>

        <p>
          Something failed while rendering this view. Your browser has not
          uploaded source code to recover from this error.
        </p>

        <details>
          <summary>Technical details</summary>
          <pre>
            {this.state.error?.message ??
              "Unknown rendering error."}
          </pre>
        </details>

        <button
          type="button"
          className="aa-button aa-button-primary"
          onClick={this.handleRecovery}
        >
          Try this view again
        </button>
      </main>
    );
  }
}