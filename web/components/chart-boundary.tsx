import React, { Component, type ReactNode } from 'react';

/** A chart failure must not hide recorded details or navigation. */
export class ChartBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <section className="error-notice" role="alert">
          <div>
            <h2>Chart unavailable</h2>
            <p>
              The chart could not be displayed. Recorded details and navigation
              remain available.
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
              Retry chart
            </button>
            <button
              className="quiet-button"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </section>
      );
    }
    return (
      <React.Fragment key={this.state.attempt}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
