import React, { Component, type ReactNode } from 'react';

/** Keep workspace navigation available when recorded content fails to render. */
export class ViewBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { failed: boolean; attempt: number; resetKey?: string }
> {
  state = { failed: false, attempt: 0, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { resetKey?: string },
  ): { failed: boolean; resetKey?: string } | null {
    return props.resetKey !== state.resetKey
      ? { failed: false, resetKey: props.resetKey }
      : null;
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed)
      return (
        <section className="error-notice section-stack" role="alert">
          <div>
            <h2>This view could not be displayed</h2>
            <p>
              Try opening it again, or reload the page. Your recorded experiment
              data has not been changed.
            </p>
          </div>
          <div className="actions">
            <button
              className="quiet-button"
              onClick={() =>
                this.setState(({ attempt }) => ({
                  failed: false,
                  attempt: attempt + 1,
                }))
              }
            >
              Try again
            </button>
            <button
              className="quiet-button"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
            <a className="quiet-button" href="#">
              Experiments
            </a>
          </div>
        </section>
      );
    return (
      <React.Fragment key={this.state.attempt}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
