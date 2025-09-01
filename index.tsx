
import React, { useState, useEffect, useRef, FormEvent, FC, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Content } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MODEL_NAME = 'gemini-2.5-pro';
const INITIAL_SYSTEM_INSTRUCTION = "You are a foundational AI agent. Your goal is to provide a strong, initial response to the user's query, whatever the topic. Break down the request, identify the core requirements, and generate a clear, well-structured starting point. This could be an outline, a basic explanation, or a foundational concept.\n\n**If the user's request involves coding:** Provide a foundational code structure or algorithm. Your code should be clean, well-commented, and directly address the core problem. Explain your approach briefly. Your response is the first step for a team of AI agents, so clarity and correctness are paramount.";
const REFINEMENT_SYSTEM_INSTRUCTION = "You are a critical analysis and refinement AI. You will receive an initial response. Your task is to critically evaluate it. Identify logical fallacies, find missing details, consider alternative perspectives, and improve the overall quality and accuracy of the response. Explain the specific changes you made and why they are improvements.\n\n**If the content is code:** Your task is to identify bugs, logical errors, edge cases, or areas for optimization. Refactor and improve the provided code, explaining the specific changes you made and why they are necessary. Your goal is to produce a more robust and efficient version of the code.";
const SYNTHESIZER_SYSTEM_INSTRUCTION = "You are a master synthesizer AI. You will receive four refined responses. Your task is to analyze, compare, and merge the best elements from each to create a single, comprehensive, and polished final answer. Ensure the final response is cohesive, well-organized, and directly addresses all aspects of the user's original query.\n\n**If the responses are code:** Synthesize the best elements from each solution to create a single, production-quality final version. Ensure the final code is complete and runnable, including all necessary boilerplate (imports, main function, etc.). Add concise comments where necessary. Your output should BE the final code block, with a brief explanation of the overall design.";

interface Message {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface ProgressState {
  initial: boolean[];
  refining: boolean[];
  synthesizing: boolean;
  verifying: boolean;
}

const LoadingIndicator: FC<{ status: string; time: number, progress: ProgressState }> = ({ status, time, progress }) => {
  const getStage = () => {
    if (status.startsWith('Initializing')) return 'initial';
    if (status.startsWith('Refining')) return 'refining';
    if (status.startsWith('Synthesizing')) return 'synthesis';
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
      {stage === 'initial' && <div className="progress-bars-container initial">{renderProgressBars(4, progress.initial)}</div>}
      {stage === 'refining' && <div className="progress-bars-container refining">{renderProgressBars(4, progress.refining)}</div>}
      {stage === 'synthesis' && <div className="progress-bars-container synthesis">{renderProgressBars(1, progress.synthesizing)}</div>}
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
            iframe.srcdoc = code;
            iframe.className = 'render-iframe';
            iframe.sandbox.add('allow-scripts');
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
  const runnableLanguages = ['python', 'py', 'javascript', 'js', 'html'];

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
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  const [isListening, setIsListening] = useState(false);
  const [executionCode, setExecutionCode] = useState<{ language: string; code: string } | null>(null);
  const [progress, setProgress] = useState<ProgressState>({
    initial: [false, false, false, false],
    refining: [false, false, false, false],
    synthesizing: false,
    verifying: false,
  });
  
  const messageListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);


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
      if (inputRef.current) {
        inputRef.current.value = transcript;
      }
    };
    recognitionRef.current.start();
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const userInput = (formData.get('userInput') as string)?.trim();
    if (!userInput) return;
    
    event.currentTarget.reset();
    if(inputRef.current) inputRef.current.value = '';

    const userMessage: Message = { role: 'user', parts: [{ text: userInput }] };
    const currentMessages = [...messages, userMessage];
    setMessages(currentMessages);
    setIsLoading(true);
    setProgress({ initial: [false, false, false, false], refining: [false, false, false, false], synthesizing: false, verifying: false });

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const mainChatHistory: Content[] = currentMessages.slice(0, -1).map(msg => ({ role: msg.role, parts: msg.parts }));
      const currentUserTurn: Content = { role: 'user', parts: [{ text: userInput }] };

      setLoadingStatus('Initializing agents...');
      const initialAnswers = Array(4).fill('');
      const initialAgentPromises = Array(4).fill(0).map((_, i) =>
        ai.models.generateContent({
          model: MODEL_NAME, contents: [...mainChatHistory, currentUserTurn], config: { systemInstruction: INITIAL_SYSTEM_INSTRUCTION }
        }).then(res => {
          initialAnswers[i] = res.text;
          setProgress(p => ({ ...p, initial: p.initial.map((s, idx) => idx === i ? true : s) }));
          return res;
        })
      );
      await Promise.all(initialAgentPromises);

      setLoadingStatus('Refining answers...');
      const refinedAnswers = Array(4).fill('');
      const refinementAgentPromises = initialAnswers.map((initialAnswer, index) => {
        const otherAnswers = initialAnswers.filter((_, i) => i !== index);
        const refinementContext = `My initial response was: "${initialAnswer}". The other agents responded with: 1. "${otherAnswers[0]}" 2. "${otherAnswers[1]}" 3. "${otherAnswers[2]}". Based on this context, critically re-evaluate and provide a new, improved response to the original query.`;
        const refinementTurn: Content = { role: 'user', parts: [{ text: `${userInput}\n\n---INTERNAL CONTEXT---\n${refinementContext}` }] };
        return ai.models.generateContent({ 
          model: MODEL_NAME, contents: [...mainChatHistory, refinementTurn], config: { systemInstruction: REFINEMENT_SYSTEM_INSTRUCTION }
        }).then(res => {
            refinedAnswers[index] = res.text;
            setProgress(p => ({ ...p, refining: p.refining.map((s, idx) => idx === index ? true : s) }));
            return res;
        });
      });
      await Promise.all(refinementAgentPromises);

      setLoadingStatus('Synthesizing final response...');
      const synthesizerContext = `Here are the four refined responses. Synthesize them into the best single, final answer.\n\nRefined 1:\n"${refinedAnswers[0]}"\n\nRefined 2:\n"${refinedAnswers[1]}"\n\nRefined 3:\n"${refinedAnswers[2]}"\n\nRefined 4:\n"${refinedAnswers[3]}"`;
      const synthesizerTurn: Content = { role: 'user', parts: [{ text: `${userInput}\n\n---INTERNAL CONTEXT---\n${synthesizerContext}` }] };
      const synthesizerResult = await ai.models.generateContent({ model: MODEL_NAME, contents: [...mainChatHistory, synthesizerTurn], config: { systemInstruction: SYNTHESIZER_SYSTEM_INSTRUCTION } });
      setProgress(p => ({ ...p, synthesizing: true }));
      
      let finalResponseText = synthesizerResult.text;
      const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/;
      const codeMatch = finalResponseText.match(codeBlockRegex);

      if (codeMatch) {
        const lang = codeMatch[1];
        const code = codeMatch[2];
        const syntaxError = await checkCodeSyntax(lang, code);

        if (syntaxError) {
          setLoadingStatus('Correcting code error...');
          const VERIFIER_SYSTEM_INSTRUCTION_DYNAMIC = `You are a code correction AI. You will be given a block of code that has a syntax error. Your SOLE task is to fix the error and return only the complete, corrected, runnable code block. Do NOT add any explanation or surrounding text.

---
ERROR MESSAGE: ${syntaxError}
---
`;
          const verifierTurn: Content = { role: 'user', parts: [{ text: `Correct the following code:\n\n\`\`\`${lang}\n${code}\n\`\`\`` }] };
          const verificationResult = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: [verifierTurn],
            config: { systemInstruction: VERIFIER_SYSTEM_INSTRUCTION_DYNAMIC }
          });
          finalResponseText = verificationResult.text;
          setProgress(p => ({ ...p, verifying: true }));
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
          <h1>Gemini Heavy</h1>
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
                {msg.parts[0].text}
              </ReactMarkdown>
            </div>
          ))}
          {isLoading && <LoadingIndicator status={loadingStatus} time={timer} progress={progress} />}
        </div>
        <form className="input-area" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            name="userInput"
            placeholder="Ask the agents..."
            aria-label="User input"
            disabled={isLoading}
          />
          <button type="button" disabled={isLoading} onClick={handleAudioInput} className={`mic-button ${isListening ? 'listening' : ''}`} aria-label="Use microphone">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/>
            </svg>
          </button>
          <button type="submit" disabled={isLoading} aria-label="Send message">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
          </button>
        </form>
      </div>
      {executionCode && <ExecutionEnvironment {...executionCode} onClose={() => setExecutionCode(null)} />}
    </>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
