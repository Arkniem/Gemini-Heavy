
import React, { useState, useEffect, useRef, FormEvent, FC, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Content } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MODEL_NAME = 'gemini-2.5-pro';
const INITIAL_SYSTEM_INSTRUCTION = "You are a foundational AI agent. Your goal is to provide a strong, initial response to the user's query, whatever the topic. Break down the request, identify the core requirements, and generate a clear, well-structured starting point. This could be an outline, a basic explanation, or a foundational concept.\n\n**If the user's request involves coding:** Provide a foundational code structure or algorithm. Your code should be clean, well-commented, and directly address the core problem. Explain your approach briefly. Your response is the first step for a team of AI agents, so clarity and correctness are paramount.";
const REFINEMENT_SYSTEM_INSTRUCTION = "You are a critical analysis and refinement AI. You will receive an initial response. Your task is to critically evaluate it. Identify logical fallacies, find missing details, consider alternative perspectives, and improve the overall quality and accuracy of the response. Explain the specific changes you made and why they are improvements.\n\n**If the content is code:** Your task is to identify bugs, logical errors, edge cases, or areas for optimization. Refactor and improve the provided code, explaining the specific changes you made and why they are necessary. Your goal is to produce a more robust and efficient version of the code.";
const CRITIQUE_AGENT_SYSTEM_INSTRUCTION = "You are a critical reviewer. You will be given an initial user query and a proposed response from another AI agent. Your sole task is to analyze the response and provide a concise, constructive critique. Identify specific weaknesses, logical fallacies, missing information, or potential inaccuracies. Do NOT write your own full response to the user. Your output should be ONLY the critique.";
const REVISION_AGENT_SYSTEM_INSTRUCTION = "You are a revision specialist. You will receive your original response, a user's query, and a critique of your response from a peer AI. Your task is to generate a new, improved final version of your response that directly addresses the points raised in the critique. Integrate the valid feedback to make your answer more accurate, complete, and well-reasoned.";
const SYNTHESIZER_SYSTEM_INSTRUCTION = "You are a master synthesizer AI. You will receive multiple refined responses. Your task is to analyze, compare, and merge the best elements from each to create a single, comprehensive, and polished final answer. Ensure the final response is cohesive, well-organized, and directly addresses all aspects of the user's original query.\n\n**If the responses are code:** Synthesize the best elements from each solution to create a single, production-quality final version. Ensure the final code is complete and runnable, including all necessary boilerplate (imports, main function, etc.). Add concise comments where necessary. Your output should BE the final code block, with a brief explanation of the overall design.";
const FINAL_REVIEW_SYSTEM_INSTRUCTION = "You are a final reviewer AI, the last quality gate before a response is sent to the user. You will receive a fully synthesized response. Your task is to perform a final check for clarity, coherence, conciseness, and tone. Make minor edits to fix grammatical errors, improve wording, and ensure the answer is polished and directly addresses the user's query. Do NOT make substantial changes or add new information. Your output should be the final, polished text.";

interface Part {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64 string
  };
}

interface Message {
  role: 'user' | 'model';
  parts: Part[];
}

interface ProgressState {
  initial: boolean[];
  refining: boolean[];
  critiquing: boolean[];
  revising: boolean[];
  synthesizing: boolean[];
  finalSynthesizing: boolean;
  reviewing: boolean;
  verifying: boolean;
}

const LoadingIndicator: FC<{ status: string; time: number, progress: ProgressState }> = ({ status, time, progress }) => {
  const getStage = () => {
    if (status.startsWith('Initializing')) return 'initial';
    if (status.startsWith('Refining')) return 'refining';
    if (status.startsWith('Critiquing')) return 'critiquing';
    if (status.startsWith('Revising')) return 'revising';
    if (status.startsWith('Synthesizing')) return 'synthesis';
    if (status.startsWith('Finalizing')) return 'finalSynthesis';
    if (status.startsWith('Performing final review')) return 'reviewing';
    if (status.startsWith('Verifying') || status.startsWith('Correcting')) return 'verification';
    return 'initial';
  };
  const stage = getStage();

  const renderProgressBars = (count: number, completed: boolean[] | boolean) => {
     return Array(count).fill(0).map((_, i) => (
        <div key={i} className={`progress-bar ${Array.isArray(completed) ? (completed[i] ? 'completed' : '') : (completed ? 'completed' : '')}`}></div>
     ));
  };

  return (
    <div className="loading-animation">
      <div className="loading-header">
        <span className="loading-status">{status}</span>
        <span className="timer-display">{(time / 1000).toFixed(1)}s</span>
      </div>
      {stage === 'initial' && <div className="progress-bars-container initial">{renderProgressBars(progress.initial.length, progress.initial)}</div>}
      {stage === 'refining' && <div className="progress-bars-container refining">{renderProgressBars(progress.refining.length, progress.refining)}</div>}
      {stage === 'critiquing' && <div className="progress-bars-container critiquing">{renderProgressBars(progress.critiquing.length, progress.critiquing)}</div>}
      {stage === 'revising' && <div className="progress-bars-container revising">{renderProgressBars(progress.revising.length, progress.revising)}</div>}
      {stage === 'synthesis' && <div className="progress-bars-container synthesis">{renderProgressBars(progress.synthesizing.length, progress.synthesizing)}</div>}
      {stage === 'finalSynthesis' && <div className="progress-bars-container final-synthesis">{renderProgressBars(1, progress.finalSynthesizing)}</div>}
      {stage === 'reviewing' && <div className="progress-bars-container reviewing">{renderProgressBars(1, progress.reviewing)}</div>}
      {stage === 'verification' && <div className="progress-bars-container verification">{renderProgressBars(1, progress.verifying)}</div>}
    </div>
  );
};

const ExecutionEnvironment: FC<{ language: string; code: string; onClose: () => void }> = ({ language, code, onClose }) => {
  const [output, setOutput] = useState<string>('');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const isHtml = language === 'html';

  const extractCode = (htmlString: string) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const scripts = doc.querySelectorAll('script');
    let code = '';
    scripts.forEach(script => {
      // Don't run external scripts in this basic environment
      if (!script.src) {
        code += script.innerHTML + '\n';
      }
    });
    // For things like pygame.js that might not use a script tag but a specific div
    if(code === '') {
        const bodyContent = doc.body.innerHTML;
        // Super basic check for non-script-based executable content
        if(htmlString.includes('pygame')) return htmlString;
    }
    return code;
  };

  const handleRun = async () => {
    setIsRunning(true);
    setOutput('');
    if (outputRef.current) {
      outputRef.current.innerHTML = '';
    }

    try {
      switch (language) {
        case 'python':
        case 'py':
          if (!(window as any).Sk) {
             setOutput('[ERROR] Skulpt (Python interpreter) is not loaded.');
             break;
          }
          (window as any).Sk.configure({
            output: (text: string) => setOutput(prev => prev + text),
            read: (x: string) => {
              if ((window as any).Sk.builtinFiles === undefined || (window as any).Sk.builtinFiles["files"][x] === undefined)
                throw new Error("File not found: '" + x + "'");
              return (window as any).Sk.builtinFiles["files"][x];
            }
          });
          await (window as any).Sk.misceval.asyncToPromise(() =>
            (window as any).Sk.importMainWithBody("<stdin>", false, code, true)
          );
          break;
        case 'javascript':
        case 'js':
          const logs: string[] = [];
          const originalConsole = { log: console.log, warn: console.warn, error: console.error };
          console.log = (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
          console.warn = (...args) => logs.push(`[WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')}`);
          console.error = (...args) => logs.push(`[ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')}`);
          try {
            const result = new Function(code)();
            if (result !== undefined) logs.push(`=> ${JSON.stringify(result, null, 2)}`);
          } catch (e: any) {
            logs.push(`[EXECUTION ERROR] ${e.message}`);
          } finally {
            setOutput(logs.join('\n'));
            console.log = originalConsole.log;
            console.warn = originalConsole.warn;
            console.error = originalConsole.error;
          }
          break;
        case 'html':
            if (outputRef.current) {
                const iframe = document.createElement('iframe');
                // Check for script tags and decide what to render
                const scriptContent = extractCode(code);
                if (scriptContent.includes('pygame')) { // Special handling for pygame.js
                     iframe.srcdoc = code;
                } else if (scriptContent) {
                    // It's just JS, run it like JS
                    handleRunJS(scriptContent);
                    return; // exit early
                } else {
                    // It's just markup, render it
                    iframe.srcdoc = code;
                }
                iframe.className = 'render-iframe';
                iframe.sandbox.add('allow-scripts', 'allow-same-origin');
                outputRef.current.innerHTML = ''; // Clear previous output
                outputRef.current.appendChild(iframe);
              }
          break;
        default:
          setOutput(`[INFO] Language '${language}' is not runnable in this environment.`);
      }
    } catch (err: any) {
      setOutput(`[RUNTIME ERROR]\n${err.toString()}`);
    } finally {
      setIsRunning(false);
    }
  };
  
    // Helper to run JS extracted from HTML
  const handleRunJS = (jsCode: string) => {
      const logs: string[] = [];
      const originalConsole = { log: console.log, warn: console.warn, error: console.error };
      console.log = (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
      // ... same as JS case
      try {
        const result = new Function(jsCode)();
        if (result !== undefined) logs.push(`=> ${JSON.stringify(result, null, 2)}`);
      } catch (e: any) {
        logs.push(`[EXECUTION ERROR] ${e.message}`);
      } finally {
        setOutput(logs.join('\n'));
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
      }
  };


  const handleFullScreen = () => {
    if (canvasRef.current) {
      if (!document.fullscreenElement) {
        canvasRef.current.requestFullscreen().catch(err => {
          alert(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
      } else {
        document.exitFullscreen();
      }
    }
  };
  
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
       if (event.key === 'Escape') {
         onClose();
       }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div className="execution-overlay" onClick={onClose}>
      <div ref={canvasRef} className="execution-canvas" onClick={e => e.stopPropagation()}>
        <div className="canvas-header">
          <span className="language-tag">{language}</span>
          <div className="canvas-buttons">
            <button onClick={handleRun} disabled={isRunning} className="run-button">
              {isRunning ? 'Running...' : 'Run'}
            </button>
             <button onClick={handleFullScreen} className="canvas-control-button" aria-label="Toggle fullscreen">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
            </button>
            <button onClick={onClose} className="canvas-control-button close" aria-label="Close canvas">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>
        <div className="canvas-body">
            <pre className="code-area"><code>{code}</code></pre>
            <div className="output-container">
              <div className="output-header">Output</div>
              <div ref={outputRef} className="output-content">
                {!isHtml && <pre>{output}</pre>}
              </div>
            </div>
        </div>
      </div>
    </div>
  );
};

const CodeBlock: FC<{ language: string; code: string; onExecute: () => void }> = ({ language, code, onExecute }) => {
  const [isCopied, setIsCopied] = useState(false);
  const runnableLanguages = ['python', 'py', 'javascript', 'js', 'html', 'java', 'c++', 'cpp', 'c'];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code: ', err);
    }
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="language-tag">{language}</span>
        <div className="code-block-buttons">
          {runnableLanguages.includes(language) && (
            <button onClick={onExecute} className="run-button">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
              Run in Canvas
            </button>
          )}
          <button onClick={handleCopy} className="copy-button">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              {isCopied ? <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/> : <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-5zm0 16H8V7h11v14z"/>}
            </svg>
            {isCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
};


const App: FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [timer, setTimer] = useState<number>(0);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [isListening, setIsListening] = useState(false);
  const [executionCode, setExecutionCode] = useState<{ language: string; code: string } | null>(null);
  const [progress, setProgress] = useState<ProgressState>({
    initial: [],
    refining: [],
    critiquing: [],
    revising: [],
    synthesizing: [],
    finalSynthesizing: false,
    reviewing: false,
    verifying: false,
  });
  const [inputText, setInputText] = useState('');
  const [attachedFile, setAttachedFile] = useState<{ data: string; mimeType: string; name: string } | null>(null);
  const [isDeepThink, setIsDeepThink] = useState<boolean>(false);
  
  const messageListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  useEffect(() => {
    document.body.className = `${theme}-mode`;
  }, [theme]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages, isLoading]);
  
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLoading) {
      interval = setInterval(() => setTimer(prevTime => prevTime + 100), 100);
    } else {
      setTimer(0);
    }
    return () => clearInterval(interval);
  }, [isLoading]);

  const handleThemeToggle = () => {
    setTheme(prev => {
      const newTheme = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', newTheme);
      return newTheme;
    });
  };
  const handleClearChat = () => setMessages([]);
  
  const handleAudioInput = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser.");
      return;
    }
    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = false;
    recognitionRef.current.interimResults = false;
    recognitionRef.current.lang = 'en-US';

    recognitionRef.current.onstart = () => setIsListening(true);
    recognitionRef.current.onend = () => setIsListening(false);
    recognitionRef.current.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
    };
    recognitionRef.current.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInputText(transcript);
    };
    recognitionRef.current.start();
  };
  
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 4 * 1024 * 1024) { // 4MB limit
      alert('File is too large. Please select a file smaller than 4MB.');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64Data = result.split(',')[1];
      setAttachedFile({
        data: base64Data,
        mimeType: file.type,
        name: file.name,
      });
    };
    reader.readAsDataURL(file);
    event.target.value = ''; // Reset file input
  };

  const checkCodeSyntax = async (language: string, code: string): Promise<string | null> => {
    switch (language.toLowerCase()) {
        case 'javascript':
        case 'js':
            try {
                new Function(code);
                return null; // No syntax error
            } catch (e: any) {
                return e.message; // Return the error message
            }
        case 'python':
        case 'py':
            if (!(window as any).Sk) return "Skulpt (Python interpreter) not loaded.";
            try {
                (window as any).Sk.configure({
                    output: () => {}, // Suppress output for the check
                    read: (x: string) => {
                        if ((window as any).Sk.builtinFiles === undefined || (window as any).Sk.builtinFiles["files"][x] === undefined)
                            throw new Error("File not found: '" + x + "'");
                        return (window as any).Sk.builtinFiles["files"][x];
                    }
                });
                await (window as any).Sk.misceval.asyncToPromise(() =>
                    (window as any).Sk.importMainWithBody("<stdin>", false, code, true)
                );
                return null; // No syntax error
            } catch (e: any) {
                return e.toString(); // Return the error string
            }
        default:
            return null; // Don't check other languages
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!inputText.trim() && !attachedFile) return;

    if (isDeepThink) {
      runOrchestration(6, true);
    } else {
      runOrchestration(4, false);
    }
  };

  const handleDeepThinkToggle = () => {
    setIsDeepThink(prev => !prev);
  };

  const runOrchestration = async (numAgents: number, isDeepThink: boolean) => {
    const userInput = inputText.trim();
    if (!userInput && !attachedFile) return;
    
    setInputText('');
    setAttachedFile(null);

    const apiParts: Part[] = [];
    if (attachedFile) {
      apiParts.push({
        inlineData: {
          mimeType: attachedFile.mimeType,
          data: attachedFile.data,
        },
      });
    }
    if (userInput) {
      apiParts.push({ text: userInput });
    }

    const userMessage: Message = { role: 'user', parts: apiParts };
    const currentMessages = [...messages, userMessage];
    setMessages(currentMessages);
    setIsLoading(true);
    setProgress({
      initial: Array(numAgents).fill(false),
      refining: Array(numAgents).fill(false),
      critiquing: isDeepThink ? Array(numAgents).fill(false) : [],
      revising: isDeepThink ? Array(numAgents).fill(false) : [],
      synthesizing: isDeepThink ? [false, false] : [false],
      finalSynthesizing: false,
      reviewing: false,
      verifying: false,
    });

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const mainChatHistory: Content[] = currentMessages.slice(0, -1).map(msg => ({
        role: msg.role, 
        parts: msg.parts.map(p => ({
          ...p.text && {text: p.text},
          ...p.inlineData && {inlineData: p.inlineData}
        })) 
      }));

      const currentUserTurn: Content = { role: 'user', parts: apiParts };

      // STAGE 1: INITIALIZATION
      setLoadingStatus('Initializing agents...');
      const initialAnswers = Array(numAgents).fill('');
      const initialAgentPromises = Array(numAgents).fill(0).map((_, i) =>
        ai.models.generateContent({
          model: MODEL_NAME, contents: [...mainChatHistory, currentUserTurn], config: { systemInstruction: INITIAL_SYSTEM_INSTRUCTION }
        }).then(res => {
          initialAnswers[i] = res.text;
          setProgress(p => ({ ...p, initial: p.initial.map((s, idx) => idx === i ? true : s) }));
          return res;
        })
      );
      await Promise.all(initialAgentPromises);

      // STAGE 3: REFINEMENT
      setLoadingStatus('Refining answers...');
      const refinedAnswers = Array(numAgents).fill('');
      const refinementAgentPromises = initialAnswers.map((currentAnswer, index) => {
        const otherAnswers = initialAnswers.filter((_, i) => i !== index);
        const otherAnswersContext = otherAnswers.map((ans, i) => `${i + 1}. "${ans}"`).join('\n');
        const refinementContext = `The response I'm working with is: "${currentAnswer}". The other agents responded with:\n${otherAnswersContext}\n\nBased on this context, critically re-evaluate and provide a new, improved response to the original query.`;
        
        const refinementParts: Part[] = [...apiParts, {text: `\n\n---INTERNAL CONTEXT---\n${refinementContext}`}];
        const refinementTurn: Content = { role: 'user', parts: refinementParts };

        return ai.models.generateContent({ 
          model: MODEL_NAME, contents: [...mainChatHistory, refinementTurn], config: { systemInstruction: REFINEMENT_SYSTEM_INSTRUCTION }
        }).then(res => {
            refinedAnswers[index] = res.text;
            setProgress(p => ({ ...p, refining: p.refining.map((s, idx) => idx === index ? true : s) }));
            return res;
        });
      });
      await Promise.all(refinementAgentPromises);
      
      let answersForSynthesis = refinedAnswers;

      // STAGES 3.5 & 3.6: CRITIQUE & REVISION (DeepThink only)
      if (isDeepThink) {
        // STAGE 3.5: CRITIQUE ROUND
        setLoadingStatus('Critiquing responses...');
        const critiques = Array(numAgents).fill('');
        const critiquePromises = refinedAnswers.map((_, index) => {
          const peerAnswer = refinedAnswers[(index + 1) % numAgents];
          const critiqueContext = `The user's query was: "${userInput}". Here is the response to critique:\n\n---RESPONSE---\n${peerAnswer}`;
          const critiqueParts: Part[] = [...apiParts, { text: `\n\n---INTERNAL CONTEXT---\n${critiqueContext}` }];
          const critiqueTurn: Content = { role: 'user', parts: critiqueParts };

          return ai.models.generateContent({
            model: MODEL_NAME, contents: [...mainChatHistory, critiqueTurn], config: { systemInstruction: CRITIQUE_AGENT_SYSTEM_INSTRUCTION }
          }).then(res => {
            critiques[index] = res.text;
            setProgress(p => ({ ...p, critiquing: p.critiquing.map((s, idx) => idx === index ? true : s) }));
            return res;
          });
        });
        await Promise.all(critiquePromises);
      
        // STAGE 3.6: FINAL REVISION ROUND
        setLoadingStatus('Revising based on feedback...');
        const finalRevisedAnswers = Array(numAgents).fill('');
        const revisionPromises = refinedAnswers.map((originalAnswer, index) => {
          // Get the critique from the agent who reviewed this one's work.
          // The `+ numAgents` prevents a negative result for the first agent (index 0).
          const peerCritique = critiques[(index - 1 + numAgents) % numAgents];
          const revisionContext = `Here was your original response:\n\n---ORIGINAL---\n${originalAnswer}\n\nHere is a critique from a peer:\n\n---CRITIQUE---\n${peerCritique}\n\nBased on the critique, provide an improved response to the original query.`;
          const revisionParts: Part[] = [...apiParts, { text: `\n\n---INTERNAL CONTEXT---\n${revisionContext}` }];
          const revisionTurn: Content = { role: 'user', parts: revisionParts };

          return ai.models.generateContent({
            model: MODEL_NAME, contents: [...mainChatHistory, revisionTurn], config: { systemInstruction: REVISION_AGENT_SYSTEM_INSTRUCTION }
          }).then(res => {
            finalRevisedAnswers[index] = res.text;
            setProgress(p => ({ ...p, revising: p.revising.map((s, idx) => idx === index ? true : s) }));
            return res;
          });
        });
        await Promise.all(revisionPromises);
        answersForSynthesis = finalRevisedAnswers;
      }

      let finalSynthesizerResponseText = '';

      if (isDeepThink) {
          // STAGE 4: PARALLEL SYNTHESIS (DeepThink)
          setLoadingStatus('Synthesizing responses...');
          const firstHalf = answersForSynthesis.slice(0, 3);
          const secondHalf = answersForSynthesis.slice(3, 6);
          
          const synthesizerPromise = (answers: string[], index: number) => {
              const context = `Here are 3 refined responses. Synthesize them into the best single, cohesive answer.\n\n` + answers.map((ans, i) => `Refined ${i+1}:\n"${ans}"`).join('\n\n');
              const parts: Part[] = [...apiParts, {text: `\n\n---INTERNAL CONTEXT---\n${context}`}];
              const turn: Content = { role: 'user', parts: parts };
              
              return ai.models.generateContent({ model: MODEL_NAME, contents: [...mainChatHistory, turn], config: { systemInstruction: SYNTHESIZER_SYSTEM_INSTRUCTION } })
                  .then(res => {
                      setProgress(p => ({ ...p, synthesizing: p.synthesizing.map((s, idx) => idx === index ? true : s) }));
                      return res.text;
                  });
          };

          const synthesizedResults = await Promise.all([
              synthesizerPromise(firstHalf, 0),
              synthesizerPromise(secondHalf, 1)
          ]);
          
          // STAGE 5: FINAL SYNTHESIS (DeepThink)
          setLoadingStatus('Finalizing response...');
          const finalSynthesizerContext = `Here are two synthesized responses from different agent groups. Your task is to analyze, compare, and merge the best elements from each to create a single, master response that is comprehensive and polished.\n\n---SYNTHESIZED RESPONSE 1---\n${synthesizedResults[0]}\n\n---SYNTHESIZED RESPONSE 2---\n${synthesizedResults[1]}`;
          const finalSynthesizerParts: Part[] = [...apiParts, {text: `\n\n---INTERNAL CONTEXT---\n${finalSynthesizerContext}`}];
          const finalSynthesizerTurn: Content = { role: 'user', parts: finalSynthesizerParts };
          
          const finalSynthesizerResult = await ai.models.generateContent({ model: MODEL_NAME, contents: [...mainChatHistory, finalSynthesizerTurn], config: { systemInstruction: SYNTHESIZER_SYSTEM_INSTRUCTION } });
          setProgress(p => ({ ...p, finalSynthesizing: true }));
          const synthesizedText = finalSynthesizerResult.text;

          // STAGE 6: FINAL REVIEW (DeepThink)
          setLoadingStatus('Performing final review...');
          const reviewContext = `Perform a final quality review on the following response. Check for clarity, coherence, grammar, and tone. Make only minor edits to polish the text. The user's original query was: "${userInput}".\n\n---RESPONSE TO REVIEW---\n${synthesizedText}`;
          const reviewTurn: Content = { role: 'user', parts: [{ text: reviewContext }] };
          
          const reviewResult = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: [...mainChatHistory, reviewTurn],
            config: { systemInstruction: FINAL_REVIEW_SYSTEM_INSTRUCTION }
          });
          setProgress(p => ({ ...p, reviewing: true }));
          finalSynthesizerResponseText = reviewResult.text;

      } else {
          // STAGE 4: SYNTHESIS (Standard)
          setLoadingStatus('Synthesizing final response...');
          const synthesizerContext = `Here are the ${numAgents} refined responses. Synthesize them into the best single, final answer.\n\n` + answersForSynthesis.map((ans, i) => `Refined ${i+1}:\n"${ans}"`).join('\n\n');
          const synthesizerParts: Part[] = [...apiParts, {text: `\n\n---INTERNAL CONTEXT---\n${synthesizerContext}`}];
          const synthesizerTurn: Content = { role: 'user', parts: synthesizerParts };

          const synthesizerResult = await ai.models.generateContent({ model: MODEL_NAME, contents: [...mainChatHistory, synthesizerTurn], config: { systemInstruction: SYNTHESIZER_SYSTEM_INSTRUCTION } });
          setProgress(p => ({ ...p, synthesizing: [true] }));
          finalSynthesizerResponseText = synthesizerResult.text;
      }
      
      let finalResponseText = finalSynthesizerResponseText;
      const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
      let match;
      let hasCorrected = false;

      while ((match = codeBlockRegex.exec(finalSynthesizerResponseText)) !== null && !hasCorrected) {
          const lang = match[1];
          const code = match[2];
          const syntaxError = await checkCodeSyntax(lang, code);

          if (syntaxError) {
              setLoadingStatus('Correcting code error...');
              const VERIFIER_SYSTEM_INSTRUCTION_DYNAMIC = `You are a code correction AI. You will be given a block of code that has a syntax error. Your SOLE task is to fix the error and return only the complete, corrected, runnable code block. Do NOT add any explanation or surrounding text.
---
ERROR MESSAGE: ${syntaxError}
---`;
              const verifierTurn: Content = { role: 'user', parts: [{ text: `Correct the following code:\n\n\`\`\`${lang}\n${code}\n\`\`\`` }] };
              const verificationResult = await ai.models.generateContent({
                  model: MODEL_NAME,
                  contents: [...mainChatHistory, verifierTurn],
                  config: { systemInstruction: VERIFIER_SYSTEM_INSTRUCTION_DYNAMIC }
              });
              
              const correctedCode = verificationResult.text;
              // Replace only the single incorrect code block
              finalResponseText = finalSynthesizerResponseText.replace(match[0], correctedCode);
              setProgress(p => ({ ...p, verifying: true }));
              hasCorrected = true; // Only correct the first error found
          }
      }

      const finalMessage: Message = { role: 'model', parts: [{ text: finalResponseText }] };
      setMessages(prev => [...prev, finalMessage]);

    } catch (error) {
      console.error('Error sending message to agents:', error);
      setMessages(prev => [...prev, { role: 'model', parts: [{ text: 'Sorry, I encountered an error. Please try again.' }] }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="chat-container">
        <header>
          <h1>G e m i n i - H e a v y</h1>
          <div className="header-controls">
            <button onClick={handleThemeToggle} aria-label="Toggle theme" className="control-button">
              {theme === 'light' ? <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.5 5.5 0 0 1-9.8-2.28A5.5 5.5 0 0 1 10.64 2.9c.44-.06.9-.1 1.36-.1z"/></svg> : <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/></svg>}
            </button>
            <button onClick={handleClearChat} aria-label="Clear chat" className="control-button">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </header>
        <div className="message-list" ref={messageListRef}>
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role}`}>
              {msg.role === 'model' && <span className="agent-label">Synthesizer Agent</span>}
              
              {msg.parts.find(p => p.inlineData) && (
                <img 
                    src={`data:${msg.parts.find(p => p.inlineData)!.inlineData!.mimeType};base64,${msg.parts.find(p => p.inlineData)!.inlineData!.data}`}
                    alt="Uploaded content"
                    className="message-image"
                />
              )}

              {msg.parts.find(p => p.text) && (
                 <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({node, className, children, ...props}) {
                      const match = /language-(\w+)/.exec(className || '');
                      if (match) {
                        const lang = match[1];
                        const codeString = String(children).replace(/\n$/, '');
                        return <CodeBlock language={lang} code={codeString} onExecute={() => setExecutionCode({ language: lang, code: codeString })} />;
                      }
                      return <code className={className} {...props}>{children}</code>;
                    }
                  }}
                >
                  {msg.parts.find(p => p.text)!.text!}
                </ReactMarkdown>
              )}
            </div>
          ))}
          {isLoading && <LoadingIndicator status={loadingStatus} time={timer} progress={progress} />}
        </div>
        <form className="input-area" onSubmit={handleSubmit}>
          {attachedFile && (
            <div className="attachment-preview">
               {attachedFile.mimeType.startsWith('image/') ? (
                 <img src={`data:${attachedFile.mimeType};base64,${attachedFile.data}`} alt={attachedFile.name} className="preview-thumbnail" />
               ) : (
                 <div className="preview-thumbnail file-icon" aria-label="File icon">
                   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM13 9V3.5L18.5 9H13z"/></svg>
                 </div>
               )}
               <span className="preview-name" title={attachedFile.name}>{attachedFile.name}</span>
               <button type="button" onClick={() => setAttachedFile(null)} className="remove-attachment-btn" aria-label="Remove attachment">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
               </button>
            </div>
          )}
          <div className="input-row">
            <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{display: 'none'}} />
            <input
              ref={inputRef}
              type="text"
              name="userInput"
              placeholder="Ask the agents..."
              aria-label="User input"
              disabled={isLoading}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
            />
            <button type="button" disabled={isLoading} onClick={() => fileInputRef.current?.click()} className="control-button attach" aria-label="Attach file">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
            </button>
            <button type="button" disabled={isLoading} onClick={handleAudioInput} className={`mic-button ${isListening ? 'listening' : ''}`} aria-label="Use microphone">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/>
              </svg>
            </button>
            <button 
              type="button" 
              onClick={handleDeepThinkToggle} 
              disabled={isLoading} 
              className={`deep-think-button ${isDeepThink ? 'selected' : ''}`} 
              aria-label="Toggle DeepThink mode"
              title="DeepThink"
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24px" height="24px">
                  <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/>
                </svg>
            </button>
            <button type="submit" disabled={isLoading || (!inputText.trim() && !attachedFile)} aria-label="Send message">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
            </button>
          </div>
        </form>
      </div>
      {executionCode && <ExecutionEnvironment {...executionCode} onClose={() => setExecutionCode(null)} />}
    </>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);