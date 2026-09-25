"""Benchmark tasks: realistic requests a developer sends to an assistant during a workday.

`private=True` marks requests whose content should never leave the machine
(secrets, credentials, personal/medical/financial data). All data here is fake.
"""

TASKS = [
    # ── quick_fact ──────────────────────────────────────────────────────────
    {"id": "qf01", "category": "quick_fact", "prompt": "What port does PostgreSQL use by default?"},
    {"id": "qf02", "category": "quick_fact", "prompt": "¿Cuál es el comando de git para deshacer el último commit sin perder los cambios?"},
    {"id": "qf03", "category": "quick_fact", "prompt": "What HTTP status code means 'Too Many Requests'?"},
    {"id": "qf04", "category": "quick_fact", "prompt": "In Python, what's the difference between a list and a tuple? One line."},
    {"id": "qf05", "category": "quick_fact", "prompt": "¿Cómo se llama el archivo donde npm guarda las versiones exactas instaladas?"},
    {"id": "qf06", "category": "quick_fact", "prompt": "What does the CSS property `box-sizing: border-box` do?"},
    {"id": "qf07", "category": "quick_fact", "prompt": "Convert 1536 MB to GB."},
    {"id": "qf08", "category": "quick_fact", "prompt": "¿Qué atajo de VS Code abre la paleta de comandos en Windows?"},
    {"id": "qf09", "category": "quick_fact", "prompt": "What is the time complexity of binary search?"},
    {"id": "qf10", "category": "quick_fact", "prompt": "Which Linux command shows which process is listening on port 8080?"},

    # ── code_small ──────────────────────────────────────────────────────────
    {"id": "cs01", "category": "code_small", "prompt": "Write a Python function that checks if a string is a palindrome, ignoring case and spaces."},
    {"id": "cs02", "category": "code_small", "prompt": "Escribe una regex que valide un correo electrónico simple (usuario@dominio.tld)."},
    {"id": "cs03", "category": "code_small", "prompt": "JavaScript: remove duplicates from an array of numbers, keeping order."},
    {"id": "cs04", "category": "code_small", "prompt": "Write a SQL query that returns the 5 customers with the highest total order amount from tables customers(id, name) and orders(id, customer_id, amount)."},
    {"id": "cs05", "category": "code_small", "prompt": "Python one-liner to flatten a list of lists."},
    {"id": "cs06", "category": "code_small", "prompt": "Escribe un script de PowerShell que liste los 10 archivos más grandes de una carpeta de forma recursiva."},
    {"id": "cs07", "category": "code_small", "prompt": "Fix this Python code:\n\ndef avg(nums):\n    return sum(nums) / len(nums)\n\nprint(avg([]))"},
    {"id": "cs08", "category": "code_small", "prompt": "Write a TypeScript type for a function that takes a string and returns a Promise of a number array."},
    {"id": "cs09", "category": "code_small", "prompt": "Write a bash loop that renames all .jpeg files in the current directory to .jpg."},
    {"id": "cs10", "category": "code_small", "prompt": "What does this do?\n\n[x for x in range(20) if x % 3 == 0 and x % 2]"},

    # ── code_complex ────────────────────────────────────────────────────────
    {"id": "cc01", "category": "code_complex", "prompt": "Implement an LRU cache in Python with O(1) get and put, without using functools or OrderedDict. Include a short test."},
    {"id": "cc02", "category": "code_complex", "prompt": "This Node.js code sometimes processes the same job twice when two workers run. Explain the race and fix it using Postgres.\n\nasync function takeJob(db) {\n  const job = await db.query(\"SELECT * FROM jobs WHERE status='pending' LIMIT 1\");\n  if (!job.rows[0]) return null;\n  await db.query(\"UPDATE jobs SET status='running' WHERE id=$1\", [job.rows[0].id]);\n  return job.rows[0];\n}"},
    {"id": "cc03", "category": "code_complex", "prompt": "Diseña el esquema de base de datos para una app de reservas de canchas deportivas: clubes, canchas, horarios, reservas, pagos y cancelaciones con reembolso parcial. Explica las decisiones clave y cómo evitar reservas dobles."},
    {"id": "cc04", "category": "code_complex", "prompt": "Write a Python asyncio program that downloads 100 URLs with at most 10 concurrent requests, retries each failed request up to 3 times with exponential backoff, and reports failures at the end. Use aiohttp."},
    {"id": "cc05", "category": "code_complex", "prompt": "Implement Dijkstra's algorithm in TypeScript with a binary heap priority queue (implement the heap yourself). Return both distances and the path to a target node."},
    {"id": "cc06", "category": "code_complex", "prompt": "Refactor this into clean, testable code and explain what you changed:\n\ndef process(d):\n    r = []\n    for k in d:\n        if d[k]['t'] == 'a':\n            if d[k]['v'] > 10:\n                r.append(k.upper())\n            else:\n                r.append(k)\n        elif d[k]['t'] == 'b':\n            try:\n                r.append(str(int(d[k]['v']) * 2))\n            except:\n                pass\n    open('out.txt','w').write(','.join(r))\n    return len(r)"},
    {"id": "cc07", "category": "code_complex", "prompt": "I have a React component that re-renders 50 times per keystroke in a large form. Walk me through how to diagnose it and the most likely fixes, with code examples."},
    {"id": "cc08", "category": "code_complex", "prompt": "Escribe un rate limiter de tipo token bucket en Go que sea seguro para concurrencia, con pruebas unitarias."},
    {"id": "cc09", "category": "code_complex", "prompt": "Explain and fix the memory leak:\n\nclass Watcher {\n  constructor(el) {\n    this.el = el;\n    window.addEventListener('resize', () => this.update());\n  }\n  update() { this.el.style.width = window.innerWidth + 'px'; }\n}\n// Called every time a modal opens:\nnew Watcher(document.querySelector('.modal'));"},
    {"id": "cc10", "category": "code_complex", "prompt": "Write a Python function that parses a simple arithmetic expression string with +, -, *, /, parentheses and unary minus, respecting precedence, without using eval. Include tests."},

    # ── explain ─────────────────────────────────────────────────────────────
    {"id": "ex01", "category": "explain", "prompt": "Explain how HTTPS protects data in transit, for a junior developer."},
    {"id": "ex02", "category": "explain", "prompt": "¿Por qué Python tiene el GIL y cuándo afecta el rendimiento de mi programa?"},
    {"id": "ex03", "category": "explain", "prompt": "Explain the difference between optimistic and pessimistic locking, with an example of when to use each."},
    {"id": "ex04", "category": "explain", "prompt": "What is a Bell state in quantum computing and why is it considered maximally entangled?"},
    {"id": "ex05", "category": "explain", "prompt": "Explica qué es el event loop de JavaScript y en qué orden se ejecutan microtasks y macrotasks, con un ejemplo."},
    {"id": "ex06", "category": "explain", "prompt": "Why does `0.1 + 0.2 != 0.3` in most programming languages?"},
    {"id": "ex07", "category": "explain", "prompt": "Explain CAP theorem and what trade-off DynamoDB and PostgreSQL each make."},
    {"id": "ex08", "category": "explain", "prompt": "How does git rebase differ from git merge, and when would a team prefer one over the other?"},

    # ── rewrite_summarize ───────────────────────────────────────────────────
    {"id": "rs01", "category": "rewrite_summarize", "prompt": "Summarize in 3 bullet points:\n\nThe quarterly review showed that the mobile team shipped 4 of 6 planned features. The two delayed features, offline sync and push notification preferences, depend on the new backend API, which slipped by three weeks due to a database migration issue. Customer satisfaction rose from 4.1 to 4.3. The team proposes adding one backend engineer and moving offline sync to next quarter."},
    {"id": "rs02", "category": "rewrite_summarize", "prompt": "Reescribe este mensaje para que suene más profesional:\n\n'oye el deploy de ayer rompió todo, nadie revisó los tests?? necesito que alguien lo arregle YA'"},
    {"id": "rs03", "category": "rewrite_summarize", "prompt": "Turn these notes into a clear commit message:\n\n- fixed the null check in user service\n- also the date parsing was wrong for UTC\n- added tests"},
    {"id": "rs04", "category": "rewrite_summarize", "prompt": "Traduce al inglés: 'La actualización se aplicará automáticamente esta noche. Si tienes cambios sin guardar, guárdalos antes de las 11 p. m.'"},
    {"id": "rs05", "category": "rewrite_summarize", "prompt": "TL;DR this in one sentence:\n\nKubernetes is an open-source container orchestration system for automating software deployment, scaling, and management. Originally designed by Google, the project is now maintained by the Cloud Native Computing Foundation. It works with many container runtimes and groups containers into pods, which are scheduled onto nodes in a cluster."},
    {"id": "rs06", "category": "rewrite_summarize", "prompt": "Write a concise README 'Installation' section for a Python CLI tool called `motkra` that needs Python 3.11+, is installed with pip, and requires an ANTHROPIC_API_KEY environment variable."},
    {"id": "rs07", "category": "rewrite_summarize", "prompt": "Resume este hilo en 2 líneas:\n\nAna: ¿movemos la demo al jueves?\nLuis: el jueves no puedo, tengo al cliente de Monterrey\nAna: ¿viernes 10am?\nLuis: viernes sí, pero necesito el ambiente de staging listo el miércoles\nMarta: yo me encargo del staging, lo tengo el martes\nAna: perfecto, viernes 10am entonces"},
    {"id": "rs08", "category": "rewrite_summarize", "prompt": "Rewrite this error message so it's helpful to an end user: 'Error: ECONNREFUSED 127.0.0.1:5432'"},

    # ── email ───────────────────────────────────────────────────────────────
    {"id": "em01", "category": "email", "prompt": "Classify this email as one of: urgent, needs_reply, fyi, spam. Answer with the label only.\n\nSubject: Your invoice #4821 is overdue\nFrom: billing@hostingco.com\nHi, your invoice of $49 was due 5 days ago. Service will be suspended in 48 hours if unpaid."},
    {"id": "em02", "category": "email", "prompt": "Clasifica este correo como: urgente, requiere_respuesta, informativo, spam. Solo la etiqueta.\n\nAsunto: ¡¡Ganaste un iPhone 17!!\nDe: premios@promo-ganadores.xyz\nHaz clic aquí para reclamar tu premio antes de 1 hora."},
    {"id": "em03", "category": "email", "prompt": "Draft a short, polite reply declining this meeting and proposing next Tuesday afternoon instead:\n\nSubject: Sync on Q3 roadmap\nHi! Can we meet Thursday at 9am to go over the Q3 roadmap? — Priya"},
    {"id": "em04", "category": "email", "prompt": "Escribe una respuesta breve a este cliente molesto, reconociendo el problema y ofreciendo una solución concreta:\n\n'Llevo 3 días sin poder entrar a mi cuenta y nadie de soporte me responde. Esto es inaceptable.'"},
    {"id": "em05", "category": "email", "prompt": "Extract the action items (who, what, when) from this email as a list:\n\nHi team, quick recap: Sara will send the updated designs by Wednesday. Tom needs to fix the login bug before the Friday release. I'll book the venue for the offsite next month. Everyone please fill the survey by end of day tomorrow."},
    {"id": "em06", "category": "email", "prompt": "Classify this email as urgent, needs_reply, fyi, or spam. Label only.\n\nSubject: Production database CPU at 98%\nFrom: alerts@monitoring.internal\nAlert triggered 3 minutes ago on db-prod-1. Queries are timing out."},
    {"id": "em07", "category": "email", "prompt": "Write a follow-up email to a recruiter I interviewed with last week asking about next steps. Keep it under 80 words."},
    {"id": "em08", "category": "email", "prompt": "Resume este correo en una línea y dime si requiere acción de mi parte:\n\nHola, te comparto el acta de la reunión de ayer. No hubo cambios en el cronograma y la próxima revisión es el 15. Saludos."},
    {"id": "em09", "category": "email", "prompt": "Write a professional email to a vendor negotiating a 15% discount on an annual contract renewal of $24,000, citing that we've been customers for 3 years and a competitor offered a lower price. Keep it firm but friendly."},
    {"id": "em10", "category": "email", "prompt": "Classify: urgent, needs_reply, fyi, or spam. Label only.\n\nSubject: Newsletter — 10 tips for better sleep\nFrom: news@wellnessdaily.com"},

    # ── reasoning ───────────────────────────────────────────────────────────
    {"id": "re01", "category": "reasoning", "prompt": "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?"},
    {"id": "re02", "category": "reasoning", "prompt": "Si 5 máquinas hacen 5 piezas en 5 minutos, ¿cuánto tardan 100 máquinas en hacer 100 piezas?"},
    {"id": "re03", "category": "reasoning", "prompt": "A service has 99.9% uptime per month. How many minutes of downtime is that in a 30-day month? Show the calculation."},
    {"id": "re04", "category": "reasoning", "prompt": "I have 3 servers. Each fails independently with probability 0.02 on a given day. What's the probability that at least one fails today?"},
    {"id": "re05", "category": "reasoning", "prompt": "We process 1,200 requests/second, each takes 250 ms on average, and each worker handles one request at a time. How many workers do we need at minimum, and how many would you provision? Explain."},
    {"id": "re06", "category": "reasoning", "prompt": "Tengo una tabla con 50 millones de filas y una consulta que filtra por fecha y por user_id, y ordena por fecha. ¿Qué índice crearías y por qué el orden de las columnas importa?"},
    {"id": "re07", "category": "reasoning", "prompt": "Three friends split a bill. Ana paid $60, Ben paid $30, Carla paid $0. The total was $90 and they want to split equally. Who owes whom and how much, with the fewest transfers?"},
    {"id": "re08", "category": "reasoning", "prompt": "An API costs $4 per million input tokens and $20 per million output tokens. A chatbot handles 10,000 conversations a day, each with 3,000 input and 500 output tokens. What's the monthly cost (30 days)?"},

    # ── private ─────────────────────────────────────────────────────────────
    {"id": "pv01", "category": "private", "private": True, "prompt": "Why does this config fail to connect?\n\nDATABASE_URL=postgres://admin:Sup3rS3cret!@db-prod.internal.acme.com:5433/billing\nPOOL_SIZE=0"},
    {"id": "pv02", "category": "private", "private": True, "prompt": "Arregla este código, no me funciona la autenticación:\n\nheaders = {'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.FAKEpayloadFAKEpayload.FAKEsig123456'}\nr = requests.get('https://api.acme.com/v1/users', header=headers)"},
    {"id": "pv03", "category": "private", "private": True, "prompt": "My doctor said my HbA1c is 6.9% and my fasting glucose was 131 mg/dL. I'm 47 and take metformin 500mg. Should I be worried? Summarize what these numbers mean."},
    {"id": "pv04", "category": "private", "private": True, "prompt": "Ayúdame a redactar un correo a mi jefe diciéndole que estoy en proceso de divorcio y necesito trabajar desde casa dos semanas. Mi jefe se llama Roberto Méndez."},
    {"id": "pv05", "category": "private", "private": True, "prompt": "Summarize my finances: salary $7,850/month net, rent $2,300, car loan $540 (14 months left), credit card debt $11,200 at 24% APR, savings $3,100. What should I pay off first?"},
    {"id": "pv06", "category": "private", "private": True, "prompt": "Check this .env for mistakes:\n\nOPENAI_API_KEY=sk-proj-FAKE1234567890abcdefghijklmnop\nSTRIPE_SECRET=sk_live_FAKE-not-a-real-key\nDEBUG=true"},
    {"id": "pv07", "category": "private", "private": True, "prompt": "Clasifica este correo: urgente, requiere_respuesta, informativo o spam.\n\nAsunto: Resultados de tu biopsia\nDe: laboratorio@clinicasanrafael.mx\nEstimado Sr. Aguilar, sus resultados ya están disponibles. Le pedimos agendar una cita con su oncólogo esta semana."},
    {"id": "pv08", "category": "private", "private": True, "prompt": "Write a message to my landlord. My card ending 4111 1111 1111 1111 was charged twice for October rent ($1,850 each). Ask for a refund of the duplicate charge."},
    {"id": "pv09", "category": "private", "private": True, "prompt": "Redacta la evaluación de desempeño de mi empleada Laura Gómez: bajo rendimiento en Q2, faltó 9 días por problemas de salud mental, pero su calidad de código es excelente. Tono empático."},
    {"id": "pv10", "category": "private", "private": True, "prompt": "Here's our internal incident note, turn it into a timeline:\n\n02:14 on-call (Diego) paged; 02:20 found customer PII table exposed via misconfigured S3 bucket acme-prod-exports; 02:41 bucket made private; 03:05 legal notified; ~18k customer records possibly accessed."},
]


# Held-out tasks: written before any router tuning, never used to tune prompts or rules.
HOLDOUT = [
    {"id": "h_qf1", "category": "quick_fact", "prompt": "What's the default branch name git uses for new repositories since 2.28 if init.defaultBranch is set to main?"},
    {"id": "h_qf2", "category": "quick_fact", "prompt": "¿Qué significa el código de estado HTTP 409?"},
    {"id": "h_qf3", "category": "quick_fact", "prompt": "What is the maximum value of a signed 32-bit integer?"},
    {"id": "h_qf4", "category": "quick_fact", "prompt": "Which Python keyword is used to create a generator function's output?"},
    {"id": "h_cs1", "category": "code_small", "prompt": "Write a Python function that returns the n-th Fibonacci number iteratively."},
    {"id": "h_cs2", "category": "code_small", "prompt": "Escribe una consulta SQL que cuente cuántos usuarios se registraron por mes en la tabla users(id, created_at)."},
    {"id": "h_cs3", "category": "code_small", "prompt": "JavaScript: write a debounce function."},
    {"id": "h_cs4", "category": "code_small", "prompt": "What's wrong with this?\n\nfor i in range(len(items)):\n    if items[i] == target:\n        items.remove(items[i])"},
    {"id": "h_cc1", "category": "code_complex", "prompt": "Implement a thread-safe bounded blocking queue in Java using ReentrantLock and Conditions, with put and take methods and a small test."},
    {"id": "h_cc2", "category": "code_complex", "prompt": "Diseña una API REST para un sistema de inventario multi-almacén con transferencias entre almacenes, incluyendo endpoints, modelos y cómo garantizar consistencia del stock."},
    {"id": "h_cc3", "category": "code_complex", "prompt": "Write a Python function that merges overlapping time intervals across multiple calendars and returns the free slots of at least 30 minutes between 9:00 and 17:00. Include tests."},
    {"id": "h_ex1", "category": "explain", "prompt": "Explain how a B-tree index speeds up database lookups."},
    {"id": "h_ex2", "category": "explain", "prompt": "¿Qué es la decoherencia cuántica y por qué dificulta construir computadoras cuánticas?"},
    {"id": "h_ex3", "category": "explain", "prompt": "What problem does OAuth 2.0 PKCE solve?"},
    {"id": "h_rs1", "category": "rewrite_summarize", "prompt": "Make this Slack message friendlier: 'Your PR is blocking the release. Fix the tests today.'"},
    {"id": "h_rs2", "category": "rewrite_summarize", "prompt": "Traduce al español: 'The migration will run during the maintenance window. Expect up to 10 minutes of read-only mode.'"},
    {"id": "h_rs3", "category": "rewrite_summarize", "prompt": "Summarize in one sentence: Our Q3 cloud bill rose 40% because a misconfigured autoscaler kept 30 idle GPU nodes running for 11 days. We added a max-node limit and a budget alert."},
    {"id": "h_em1", "category": "email", "prompt": "Classify as urgent, needs_reply, fyi, or spam. Label only.\n\nSubject: Can you review my PR by Friday?\nFrom: dana@company.com"},
    {"id": "h_em2", "category": "email", "prompt": "Clasifica: urgente, requiere_respuesta, informativo o spam. Solo la etiqueta.\n\nAsunto: Mantenimiento programado del sábado\nDe: it@empresa.com\nEl sábado de 2 a 4 a.m. no habrá VPN."},
    {"id": "h_em3", "category": "email", "prompt": "Write a two-sentence reply thanking a colleague for covering my on-call shift last weekend."},
    {"id": "h_em4", "category": "email", "prompt": "Extract the dates and deadlines from this email as a list:\n\nThe beta opens March 3. Feedback forms are due March 17, and the final release is planned for April 1 unless blockers are found by March 24."},
    {"id": "h_re1", "category": "reasoning", "prompt": "If a cache has a 90% hit rate, hits take 1 ms and misses take 50 ms, what's the average latency?"},
    {"id": "h_re2", "category": "reasoning", "prompt": "Un equipo de 4 personas estima 120 horas de trabajo. Si cada persona dedica 6 horas productivas al día, ¿en cuántos días hábiles terminan?"},
    {"id": "h_re3", "category": "reasoning", "prompt": "We store 2 KB per event, 5 million events per day, and keep 90 days. How much storage do we need, and what would you add as headroom?"},
    {"id": "h_pv1", "category": "private", "private": True, "prompt": "Why does this fail?\n\nredis_url = 'redis://:Adm1nP4ss2024@cache-01.internal.corp:6379/0'\nclient = Redis.from_url(redis_url, decode_response=True)"},
    {"id": "h_pv2", "category": "private", "private": True, "prompt": "Mi psiquiatra me subió la sertralina a 100 mg y ahora duermo mal. ¿Es normal al principio? Tengo 34 años."},
    {"id": "h_pv3", "category": "private", "private": True, "prompt": "Help me write a message to HR: my manager, Kevin Walsh, made comments about my pregnancy in yesterday's standup and I want it documented."},
    {"id": "h_pv4", "category": "private", "private": True, "prompt": "Review this deploy script:\n\nexport AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKE1234\nexport AWS_SECRET_ACCESS_KEY=fakeSecretKeyValue0000000000000000000\naws s3 sync ./build s3://acme-site --delete"},
    {"id": "h_pv5", "category": "private", "private": True, "prompt": "I owe $38,000 in student loans at 6.8%, earn $5,200/month after tax and have $900 left after expenses. Should I refinance or invest the $900?"},
]
