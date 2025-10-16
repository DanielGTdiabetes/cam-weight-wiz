import { Component, ErrorInfo, ReactNode } from "react";
import { RecoveryMode } from "./RecoveryMode";
import { logger } from "@/services/logger";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log the error to our logging service
    logger.error("React Error Boundary caught an error", {
      error: error.toString(),
      componentStack: errorInfo.componentStack,
      stack: error.stack,
    });

    // Mark recovery mode as needed
    localStorage.setItem("recovery_mode", "true");
    localStorage.setItem(
      "last_error",
      JSON.stringify({
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      })
    );

    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return <RecoveryMode />;
    }

    return this.props.children;
  }
}
