import React from "react";

interface ErrorBoundaryState {
  error: string | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }

  componentDidCatch(error: unknown) {
    console.error("Mobile app crashed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-screen">
          <h1>Chat Soft</h1>
          <p>移动端页面发生错误</p>
          <pre>{this.state.error}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}
