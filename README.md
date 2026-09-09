Boss Recruiter Multi-Agent

面向招聘端的 Boss 招聘流程 Multi-Agent 自动化系统
基于岗位画像、候选人清洗过滤、LLM 匹配评分、沟通意图识别与简历洞察，构建从候选人发现到初筛跟进的招聘提效闭环。

项目背景

招聘团队在 Boss 直聘推荐页、沟通页中需要反复完成候选人筛选、打招呼、收取简历、同步飞书等操作。传统流程高度依赖人工判断，面对单岗位几百到几千条候选人时，存在处理效率低、筛选标准不一致、关键词误命中、重复触达和后续跟进缺少沉淀等问题。

本项目在原有 Boss 页面自动化能力基础上，引入 LangGraph 多 Agent 编排，将“无差别批量执行”升级为“岗位画像驱动的智能筛选、触达与简历初筛系统”。

核心能力
1. 岗位画像 Agent

将 HR 输入的 JD、学历、年龄范围、城市、经验要求和技能关键词结构化为统一岗位画像，作为后续候选人过滤、评分和话术生成的标准来源。

2. 双漏斗 Veto Engine

候选人进入 LLM 评分前，先经过硬规则过滤，包括学历、年龄、城市、重复候选人、历史触达状态、岗位关键词和黑名单关键词等维度。

通过规则层先拦截明显不匹配候选人，再将候选人交给 LLM 深度评估，降低无效 Token 消耗和无效触达。

3. 候选人评分 Agent

结合岗位画像、Boss 候选人卡片、历史沟通状态和简历摘要，对候选人输出匹配评分、匹配点、风险点和触达建议。

评分决策分为：

高匹配：进入触达链路
边界样本：进入人工复核
低匹配：自动跳过
硬规则失败：一票否决
4. 触达话术 Agent + Message Critic

根据候选人亮点和岗位画像生成个性化打招呼话术，并通过质检节点检查是否存在虚构薪资、承诺转正、夸大福利、话术过长等风险，避免模型输出不可控内容。

5. 沟通意图识别 Agent

识别候选人回复意图，将回复归类为有兴趣、不考虑、询问薪资、询问地点、询问岗位详情、已发送简历、需要人工处理等状态，并根据意图决定后续动作。

6. 简历洞察 Agent

结合 PyMuPDF / Tesseract OCR 提取附件简历内容，并调用 LLM 生成候选人摘要、岗位匹配点、风险点和面试追问问题，辅助 HR 快速完成初筛判断。

技术架构

Electron 控制台
→ FastAPI 后端服务
→ LangGraph Agent Workflow
→ 岗位画像 / 规则过滤 / LLM 评分 / 话术生成 / 意图识别 / 简历洞察
→ Boss 自动化工具 / 简历解析工具 / 飞书同步工具
→ SQLite 状态库 / 飞书看板 / 本地任务日志

LangGraph 流程设计
候选人触达链路

load_job_profile
→ collect_candidate
→ hard_filter
→ veto：record_skip
→ pass：candidate_score
→ low_score：record_skip
→ uncertain：human_review
→ high_score：message_generate
→ message_critic
→ boss_send_greeting
→ update_candidate_state

沟通与简历处理链路

load_chat_history
→ conversation_intent
→ not_interested：mark_stop
→ interested：ask_resume
→ ask_salary / ask_details：human_review
→ send_resume：resume_parse
→ resume_insight
→ sync_feishu

技术栈
模块	技术
控制台	Electron / React
后端接口	FastAPI
Agent 编排	LangGraph
LLM 调用	LangChain / OpenAI-compatible API
浏览器自动化	Playwright / Chrome CDP
数据存储	SQLite WAL
简历解析	PyMuPDF / Tesseract OCR
实时日志	SSE
数据同步	飞书多维表格 / 飞书招聘
项目价值
将原有脚本化招聘流程升级为多 Agent 决策系统；
支持单岗位从大量候选人中筛选高匹配人选进入触达池；
通过规则过滤 + LLM 评分降低无效触达；
通过意图识别和人工接管提升自动化流程可控性；
通过简历洞察 Agent 自动生成候选人摘要、风险点和面试问题；
通过状态库和任务日志沉淀完整招聘处理链路，便于复盘和追踪。
说明

本项目仅作为招聘流程自动化与 Multi-Agent 架构设计实践展示，不包含可直接运行的部署说明、账号配置、平台登录信息或真实候选人数据。
