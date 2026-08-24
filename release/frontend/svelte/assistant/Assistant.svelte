<script lang="ts">
  /**
   * The assistant panel: what has been said, and the box that says the next
   * thing.
   *
   * It is handed the files rather than asking for them, so what a question
   * carries is decided by whoever knows what is on screen -- and so this can
   * be looked at, in a test, with any set of files at all.
   */
  import MessagesSquareIcon from "@lucide/svelte/icons/messages-square";
  import {
    Conversation as Transcript,
    ConversationContent,
    ConversationEmptyState,
    ConversationScrollButton,
  } from "../shadcn/ai-elements/conversation";
  import { Loader } from "../shadcn/ai-elements/loader";
  import {
    Message,
    MessageContent,
    MessageResponse,
  } from "../shadcn/ai-elements/message";
  import {
    PromptInput,
    PromptInputBody,
    PromptInputHeader,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputToolbar,
    PromptInputTools,
    type PromptInputMessage,
  } from "../shadcn/ai-elements/prompt-input";
  import { Suggestion, Suggestions } from "../shadcn/ai-elements/suggestion";
  import PanelHeading from "../shell/PanelHeading.svelte";
  import AttachedFiles from "./AttachedFiles.svelte";
  import type { Conversation } from "./conversation.svelte";

  let {
    conversation,
    attached,
  }: {
    conversation: Conversation;
    /** What goes with the next question, and how much goes with each. */
    attached: { path: string; executions: number }[];
  } = $props();

  /** Streamdown's shadcn base leaves lists unmarked. These are the markers. */
  const LISTS =
    "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5";

  const openers = ["Explain this file", "Why did it fail?", "Write a test"];

  const ask = (text: string) =>
    conversation.ask(
      text,
      attached.map(({ path }) => path),
    );
</script>

<section
  class="bg-sidebar grid h-full min-h-0 w-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
  data-region="assistant"
>
  <PanelHeading label="Assistant" icon={MessagesSquareIcon} />

  <Transcript class="min-h-0 min-w-0">
    <ConversationContent class="gap-6 p-3">
      {#each conversation.turns as turn (turn.id)}
        <Message from={turn.from} data-turn={turn.id}>
          <MessageContent>
            <MessageResponse content={turn.text} class={LISTS} />
          </MessageContent>
        </Message>
      {:else}
        <ConversationEmptyState
          title="Ask about what you are looking at"
          description="Whatever is open in the dock goes along with your question."
        >
          {#snippet icon()}
            <MessagesSquareIcon class="size-6" />
          {/snippet}
        </ConversationEmptyState>
      {/each}
      {#if conversation.pending}
        <Message from="assistant" data-region="pending">
          <MessageContent>
            <Loader />
          </MessageContent>
        </Message>
      {/if}
    </ConversationContent>
    <ConversationScrollButton />
  </Transcript>

  <div class="flex min-w-0 flex-col gap-2 border-t p-3">
    {#if conversation.turns.length === 0}
      <Suggestions>
        {#each openers as opener (opener)}
          <Suggestion suggestion={opener} onclick={ask} />
        {/each}
      </Suggestions>
    {/if}
    <PromptInput onSubmit={(message: PromptInputMessage) => ask(message.text)}>
      <PromptInputHeader class="border-b px-3 py-2">
        <AttachedFiles {attached} />
      </PromptInputHeader>
      <PromptInputBody>
        <PromptInputTextarea placeholder="Ask about the files in view…" />
      </PromptInputBody>
      <PromptInputToolbar class="px-2 pb-2">
        <PromptInputTools />
        <PromptInputSubmit status={conversation.status} />
      </PromptInputToolbar>
    </PromptInput>
  </div>
</section>
