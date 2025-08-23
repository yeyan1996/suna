'use client';

import React, { useState, Suspense, useCallback } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter, useSearchParams } from 'next/navigation';
import Joyride, { CallBackProps, STATUS, Step } from 'react-joyride';
import {
  ChatInput,
  ChatInputHandles,
} from '@/components/thread/chat-input/chat-input';
import {
  BillingError,
  AgentRunLimitError,
} from '@/lib/api';
import { useIsMobile } from '@/hooks/use-mobile';
import { useBillingError } from '@/hooks/useBillingError';
import { BillingErrorAlert } from '@/components/billing/usage-limit-alert';
import { useAccounts } from '@/hooks/use-accounts';
import { config, isLocalMode, isStagingMode } from '@/lib/config';
import { useInitiateAgentWithInvalidation } from '@/hooks/react-query/dashboard/use-initiate-agent';

import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { cn } from '@/lib/utils';
import { BillingModal } from '@/components/billing/billing-modal';
import { useAgentSelection } from '@/lib/stores/agent-selection-store';
import { Examples } from './examples';
import { useThreadQuery } from '@/hooks/react-query/threads/use-threads';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { KortixLogo } from '../sidebar/kortix-logo';
import { AgentRunLimitDialog } from '@/components/thread/agent-run-limit-dialog';
import { useFeatureFlag } from '@/lib/feature-flags';
import { CustomAgentsSection } from './custom-agents-section';
import { toast } from 'sonner';
import { ReleaseBadge } from '../auth/release-badge';
import { useDashboardTour } from '@/hooks/use-dashboard-tour';
import { TourConfirmationDialog } from '@/components/tour/TourConfirmationDialog';

const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

const dashboardTourSteps: Step[] = [
  {
    target: '[data-tour="chat-input"]',
    content: 'Type your questions or tasks here. Suna can help with research, analysis, automation, and much more.',
    title: 'Start a Conversation',
    placement: 'top',
    disableBeacon: true,
  },
  {
    target: '[data-tour="my-agents"]',
    content: 'Create and manage your custom AI agents here. Build specialized agents for different tasks and workflows.',
    title: 'Manage Your Agents',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="examples"]',
    content: 'Get started quickly with these example prompts. Click any example to try it out.',
    title: 'Example Prompts',
    placement: 'top',
    disableBeacon: true,
  },
];

export function DashboardContent() {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const { 
    selectedAgentId, 
    setSelectedAgent, 
    initializeFromAgents,
    getCurrentAgent
  } = useAgentSelection();
  const [initiatedThreadId, setInitiatedThreadId] = useState<string | null>(null);
  const { billingError, handleBillingError, clearBillingError } =
    useBillingError();
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [agentLimitData, setAgentLimitData] = useState<{
    runningCount: number;
    runningThreadIds: string[];
  } | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const { data: accounts } = useAccounts();
  const personalAccount = accounts?.find((account) => account.personal_account);
  const chatInputRef = React.useRef<ChatInputHandles>(null);
  const initiateAgentMutation = useInitiateAgentWithInvalidation();
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  // Tour integration
  const {
    run,
    stepIndex,
    setStepIndex,
    stopTour,
    showWelcome,
    handleWelcomeAccept,
    handleWelcomeDecline,
  } = useDashboardTour();

  // Feature flag for custom agents section
  const { enabled: customAgentsEnabled } = useFeatureFlag('custom_agents');

  // Fetch agents to get the selected agent's name
  const { data: agentsResponse } = useAgents({
    limit: 100,
    sort_by: 'name',
    sort_order: 'asc'
  });

  const agents = agentsResponse?.agents || [];
  const selectedAgent = selectedAgentId
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;
  const displayName = selectedAgent?.name || 'Suna';
  const agentAvatar = undefined;
  const isSunaAgent = selectedAgent?.metadata?.is_suna_default || false;

  const threadQuery = useThreadQuery(initiatedThreadId || '');

  const enabledEnvironment = isStagingMode() || isLocalMode();

  React.useEffect(() => {
    if (agents.length > 0) {
      initializeFromAgents(agents, undefined, setSelectedAgent);
    }
  }, [agents, initializeFromAgents, setSelectedAgent]);

  React.useEffect(() => {
    const agentIdFromUrl = searchParams.get('agent_id');
    if (agentIdFromUrl && agentIdFromUrl !== selectedAgentId) {
      setSelectedAgent(agentIdFromUrl);
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('agent_id');
      router.replace(newUrl.pathname + newUrl.search, { scroll: false });
    }
  }, [searchParams, selectedAgentId, router, setSelectedAgent]);

  React.useEffect(() => {
    if (threadQuery.data && initiatedThreadId) {
      const thread = threadQuery.data;
      if (thread.project_id) {
        router.push(`/projects/${thread.project_id}/thread/${initiatedThreadId}`);
      } else {
        router.push(`/agents/${initiatedThreadId}`);
      }
      setInitiatedThreadId(null);
    }
  }, [threadQuery.data, initiatedThreadId, router]);

  const handleTourCallback = useCallback((data: CallBackProps) => {
    const { status, type, index } = data;
    
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      stopTour();
    } else if (type === 'step:after') {
      setStepIndex(index + 1);
    }
  }, [stopTour, setStepIndex]);

  const handleSubmit = async (
    message: string,
    options?: {
      model_name?: string;
      enable_thinking?: boolean;
      reasoning_effort?: string;
      stream?: boolean;
      enable_context_manager?: boolean;
    },
  ) => {
    if (
      (!message.trim() && !chatInputRef.current?.getPendingFiles().length) ||
      isSubmitting
    )
      return;

    setIsSubmitting(true);

    try {
      const files = chatInputRef.current?.getPendingFiles() || [];
      localStorage.removeItem(PENDING_PROMPT_KEY);

      const formData = new FormData();
      formData.append('prompt', message);

      // Add selected agent if one is chosen
      if (selectedAgentId) {
        formData.append('agent_id', selectedAgentId);
      }

      files.forEach((file, index) => {
        const normalizedName = normalizeFilenameToNFC(file.name);
        formData.append('files', file, normalizedName);
      });

      if (options?.model_name) formData.append('model_name', options.model_name);
      formData.append('enable_thinking', String(options?.enable_thinking ?? false));
      formData.append('reasoning_effort', options?.reasoning_effort ?? 'low');
      formData.append('stream', String(options?.stream ?? true));
      formData.append('enable_context_manager', String(options?.enable_context_manager ?? false));

      const result = await initiateAgentMutation.mutateAsync(formData);

      if (result.thread_id) {
        setInitiatedThreadId(result.thread_id);
      } else {
        throw new Error('Agent initiation did not return a thread_id.');
      }
      chatInputRef.current?.clearPendingFiles();
    } catch (error: any) {
      console.error('Error during submission process:', error);
      if (error instanceof BillingError) {
        setShowPaymentModal(true);
      } else if (error instanceof AgentRunLimitError) {
        const { running_thread_ids, running_count } = error.detail;
        setAgentLimitData({
          runningCount: running_count,
          runningThreadIds: running_thread_ids,
        });
        setShowAgentLimitDialog(true);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Operation failed';
        toast.error(errorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  React.useEffect(() => {
    const timer = setTimeout(() => {
      const pendingPrompt = localStorage.getItem(PENDING_PROMPT_KEY);

      if (pendingPrompt) {
        setInputValue(pendingPrompt);
        setAutoSubmit(true);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    if (autoSubmit && inputValue && !isSubmitting) {
      const timer = setTimeout(() => {
        handleSubmit(inputValue);
        setAutoSubmit(false);
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [autoSubmit, inputValue, isSubmitting]);

  return (
    <>
      <Joyride
        steps={dashboardTourSteps}
        run={run}
        stepIndex={stepIndex}
        callback={handleTourCallback}
        continuous
        showProgress
        showSkipButton
        disableOverlayClose
        disableScrollParentFix
        styles={{
          options: {
            primaryColor: 'hsl(var(--primary))',
            backgroundColor: '#ffffff',
            textColor: 'hsl(var(--foreground))',
            overlayColor: 'rgba(0, 0, 0, 0.5)',
            arrowColor: '#ffffff',
            zIndex: 1000,
          },
          tooltip: {
            backgroundColor: '#ffffff',
            borderRadius: 8,
            fontSize: 14,
            padding: 20,
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.15)',
            border: '1px solid hsl(var(--border))',
          },
          tooltipContainer: {
            textAlign: 'left',
          },
          tooltipTitle: {
            color: 'hsl(var(--foreground))',
            fontSize: 16,
            fontWeight: 600,
            marginBottom: 8,
          },
          tooltipContent: {
            color: 'hsl(var(--foreground))',
            fontSize: 14,
            lineHeight: 1.5,
          },
          buttonNext: {
            backgroundColor: 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            fontSize: 12,
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            fontWeight: 500,
          },
          buttonBack: {
            color: 'hsl(var(--muted-foreground))',
            backgroundColor: 'transparent',
            fontSize: 12,
            padding: '8px 16px',
            border: '1px solid hsl(var(--border))',
            borderRadius: 6,
          },
          buttonSkip: {
            color: 'hsl(var(--muted-foreground))',
            backgroundColor: 'transparent',
            fontSize: 12,
            border: 'none',
          },
          buttonClose: {
            color: 'hsl(var(--muted-foreground))',
            backgroundColor: 'transparent',
          },
        }}
      />
      
      <TourConfirmationDialog
        open={showWelcome}
        onAccept={handleWelcomeAccept}
        onDecline={handleWelcomeDecline}
      />

      <BillingModal 
        open={showPaymentModal} 
        onOpenChange={setShowPaymentModal}
        showUsageLimitAlert={true}
      />
      <div className="flex flex-col h-screen w-full overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="min-h-full flex flex-col">
            {customAgentsEnabled && (
              <div className="flex justify-center px-4 pt-4 md:pt-8">
                <ReleaseBadge text="Custom Agents, Playbooks, and more!" link="/agents?tab=my-agents" />
              </div>
            )}
            <div className="flex-1 flex items-center justify-center px-4 py-8">
              <div className="w-full max-w-[650px] flex flex-col items-center justify-center space-y-4 md:space-y-6">
                <div className="flex flex-col items-center text-center w-full">
                  <p 
                    className="tracking-tight text-2xl md:text-3xl font-normal text-foreground/90"
                    data-tour="dashboard-title"
                  >
                    What would you like to do today?
                  </p>
                </div>
                <div className="w-full" data-tour="chat-input">
                  <ChatInput
                    ref={chatInputRef}
                    onSubmit={handleSubmit}
                    loading={isSubmitting}
                    placeholder="Describe what you need help with..."
                    value={inputValue}
                    onChange={setInputValue}
                    hideAttachments={false}
                    selectedAgentId={selectedAgentId}
                    onAgentSelect={setSelectedAgent}
                    enableAdvancedConfig={true}
                    onConfigureAgent={(agentId) => router.push(`/agents/config/${agentId}`)}
                  />
                </div>
                <div className="w-full" data-tour="examples">
                  <Examples onSelectPrompt={setInputValue} count={isMobile ? 3 : 4} />
                </div>
              </div>
            </div>
            {enabledEnvironment && customAgentsEnabled && (
              <div className="w-full px-4 pb-8" data-tour="custom-agents">
                <div className="max-w-7xl mx-auto">
                  <CustomAgentsSection 
                    onAgentSelect={setSelectedAgent}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
        
        <BillingErrorAlert
          message={billingError?.message}
          currentUsage={billingError?.currentUsage}
          limit={billingError?.limit}
          accountId={personalAccount?.account_id}
          onDismiss={clearBillingError}
          isOpen={!!billingError}
        />
      </div>

      {agentLimitData && (
        <AgentRunLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          runningCount={agentLimitData.runningCount}
          runningThreadIds={agentLimitData.runningThreadIds}
          projectId={undefined}
        />
      )}
    </>
  );
}
