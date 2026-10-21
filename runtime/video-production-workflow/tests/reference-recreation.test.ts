import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sha256Canonical } from "../src/canonical-json.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function sha256Path(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function createFixture(filePath: string, color = "navy", frequency = 440) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=640x360:r=30:d=1`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

function referenceInput() {
  return {
    sourceUrl: "https://weixin.qq.com/sph/example",
    acquisition: {
      method: "user_provided",
      tool: "test-fixture",
      retrievedAt: "2026-09-27T00:00:00.000Z",
    },
    intendedUse: "analysis_and_original_recreation",
    rightsNotes: ["仅分析表达机制；未获得逐镜复制授权"],
    referenceVerbatimTranscript: {
      language: "zh",
      reviewStatus: "human_verified",
      segments: [
        { start: 0, end: 0.5, text: "都说AI能省钱", speaker: "原片讲述者", confidence: 1 },
        { start: 0.5, end: 1, text: "我怎么越花越多", speaker: "原片讲述者", confidence: 1 },
      ],
      words: [
        { start: 0, end: 0.18, text: "都说", confidence: 1 },
        { start: 0.18, end: 0.34, text: "AI", confidence: 1 },
        { start: 0.34, end: 0.5, text: "能省钱", confidence: 1 },
        { start: 0.5, end: 0.7, text: "我怎么", confidence: 1 },
        { start: 0.7, end: 1, text: "越花越多", confidence: 1 },
      ],
    },
    shots: [
      {
        slug: "hook-question",
        sourceIn: 0,
        sourceOut: 0.5,
        shotSize: "中近景",
        composition: "人物居中偏左，右侧留出大字区",
        cameraPosition: "平视，镜头距人物约一臂半",
        cameraMovement: "固定机位，结尾轻微数字推近",
        subjectAction: "讲述者抬眉看向镜头，右手摊开",
        visualFunction: "用反常识疑问完成前三秒钩子",
        onScreenText: ["AI 不是应该省钱吗？"],
        transitionIn: "直接开场",
        transitionOut: "硬切到账单特写",
        audio: { dialogue: "都说AI能省钱", sfx: ["轻提示音"], musicCue: "节拍第一拍进入" },
        evidence: ["00:00.250 关键帧"],
        confidence: 0.95,
      },
      {
        slug: "cost-reveal",
        sourceIn: 0.5,
        sourceOut: 1,
        shotSize: "账单屏幕特写",
        composition: "费用数字占画面中心，人物缩至左下角画中画",
        cameraPosition: "屏幕正投影",
        cameraMovement: "费用数字逐级上跳",
        subjectAction: "鼠标连续点开三个付费项目",
        visualFunction: "把抽象的越花越多变成可见证据",
        onScreenText: ["订阅 + API + 生成额度"],
        transitionIn: "硬切",
        transitionOut: "数字停住后切回人物",
        audio: { dialogue: "我怎么越花越多", sfx: ["三次金额跳字声"], musicCue: "第三拍短暂停顿" },
        evidence: ["00:00.750 关键帧"],
        confidence: 0.92,
      },
    ],
    editGrammar: {
      hook: "反问句与大字在第一拍同步出现",
      structure: ["反常识提问", "费用证据", "解释原因", "给出行动"],
      pacing: "前一秒一切，解释段放慢到三秒一切",
      captions: "逐词高亮，但每屏不超过两行",
      transitions: "以硬切为主，只在账单数字处使用匹配切",
      broll: "只在出现具体费用名词时覆盖口播",
      motionGraphics: "数字上跳承担信息变化，不做装饰性漂浮",
      soundDesign: "关键费用出现时单点提示音，避免连续堆叠",
      music: "轻快电子节奏，结论前降噪让出人声",
    },
    transferablePatterns: [
      { name: "反问钩子", evidence: ["hook-question"], adaptation: "换成目标业务里的真实矛盾" },
      { name: "逐项费用显形", evidence: ["cost-reveal"], adaptation: "使用自有数据重新制作信息卡" },
    ],
    protectedElements: ["原作者台词", "原作者形象与声音", "原视频账单截图与品牌标识"],
    unknowns: [],
  };
}

function recreationInput(copied = false) {
  return {
    brief: {
      audience: "正在把 AI 用进保险工作的从业者",
      objective: "说明工具越多不等于产出越高，并给出选择方法",
      platform: "视频号",
      aspectRatio: "16:9",
      durationSeconds: 12,
      tone: "坦率、具体、有一点自嘲",
      facts: ["只展示本人真实订阅与使用记录"],
      brandRules: ["深绿色为主色", "字幕不得遮挡人脸"],
    },
    adaptationPolicy: {
      mode: "structure_recreation",
      borrowedMechanisms: ["反问钩子", "把抽象成本拆成三项可见证据"],
      mustReplace: ["原片台词", "原作者身份", "原账单画面", "品牌元素"],
      replacementMap: [
        { sourceElement: "原作者台词", action: "replace", replacement: "改为王杰本人关于 AI 工具筛选的原创逐字稿", verification: "逐句对照原片逐字稿与目标提词稿", targetPaths: ["/targetVerbatimScript/0/text"], replacementAnchors: ["AI 工具"] },
        { sourceElement: "原作者形象与声音", action: "replace", replacement: "由王杰本人出镜并使用本人原声", verification: "成片人脸与音轨人工确认", targetPaths: ["/shootingPlan/0/performance"], replacementAnchors: ["王杰本人"] },
        { sourceElement: "原视频账单截图与品牌标识", action: "replace", replacement: "仅使用本人脱敏后的工具清单和自有视觉标识", verification: "素材清单与关键帧审查", targetPaths: ["/editBlueprint/1/brollSlots/0/sourcePlan/provenance"], replacementAnchors: ["本人脱敏后的工具清单"] },
        { sourceElement: "原片台词", action: "replace", replacement: "改写为‘现在我只看三件事’的目标逐字稿，不复述原句", verification: "原创性扫描和用户审稿", targetPaths: ["/targetVerbatimScript/1/text"], replacementAnchors: ["现在我只看三件事"] },
        { sourceElement: "原作者身份", action: "replace", replacement: "使用王杰自己的职业语境与经历", verification: "拍摄表和成片人工核对", targetPaths: ["/shootingPlan/0/scene"], replacementAnchors: ["王杰自己的职业语境"] },
        { sourceElement: "原账单画面", action: "replace", replacement: "使用本人一周任务统计与脱敏录屏", verification: "B-roll 来源与哈希记录", targetPaths: ["/editBlueprint/1/brollSlots/0/visual"], replacementAnchors: ["本人一周任务统计"] },
        { sourceElement: "品牌元素", action: "replace", replacement: "使用深绿色自有品牌系统", verification: "关键帧品牌检查", targetPaths: ["/brief/brandRules/0"], replacementAnchors: ["深绿色"] },
      ],
      authorizationEvidence: [],
    },
    creativeOptions: [
      {
        slug: "balanced-evidence",
        name: "证据感平衡版",
        coreIdea: "保留反问钩子，用本人真实工具清单完成论证",
        referenceUse: "借鉴反问和逐项显形，不沿用原台词与账单画面",
        visualApproach: "真人横屏口播加自有录屏和克制信息卡",
        productionCost: "中等，一次实拍加一段录屏",
        risk: "需要遮挡录屏里的账号与金额",
        fit: "最适合当前视频号与保险 AI 课程受众",
      },
      {
        slug: "minimal-talk",
        name: "极简口播版",
        coreIdea: "只保留结构节奏，用三张实体卡片完成说明",
        referenceUse: "只借鉴信息递进",
        visualApproach: "单机位口播加手部卡片特写",
        productionCost: "低，当天可拍",
        risk: "视觉证据弱于录屏",
        fit: "适合快速日更",
      },
    ],
    selectedOptionSlug: "balanced-evidence",
    scriptOutline: [
      { slug: "hook", purpose: "提出目标受众的真实矛盾", referenceMechanism: "反问钩子", targetMessage: "工具多了，工作未必更快" },
      { slug: "method", purpose: "给出可以执行的筛选方法", referenceMechanism: "逐项显形", targetMessage: "按任务、频率、回报保留工具" },
    ],
    targetVerbatimScript: [
      {
        slug: "line-hook",
        sectionSlug: "hook",
        text: copied ? "都说AI能省钱" : "我装了十几个 AI 工具，做一条视频反而更慢了。",
        purpose: "让观众立刻认出工具堆叠的困境",
        delivery: "先看镜头，停半拍，再把十几个说重",
      },
      {
        slug: "line-method",
        sectionSlug: "method",
        text: "现在我只看三件事：是不是高频任务，能不能稳定复用，最后有没有真实产出。",
        purpose: "交付筛选标准",
        delivery: "说到三件事时伸出三根手指，每项之间留四分之一秒",
      },
    ],
    shootingPlan: [
      {
        slug: "target-hook",
        timelineIn: 0,
        timelineOut: 5,
        lineSlugs: ["line-hook"],
        referenceShotSlugs: ["hook-question"],
        scene: "王杰自己的职业语境：保险 AI 工作书桌前，背景能看到关闭的工具图标墙",
        framing: "横屏中近景，人物占左侧五分之三",
        composition: "右侧预留十几个 AI 工具大字区，眼睛位于上三分线",
        cameraPosition: "相机与眼睛等高，等效 50mm，距人物约 1.4 米",
        cameraMovement: "全程固定；说到更慢时后期推近 6%",
        subjectAction: "开场双手放桌面，说到十几个时指向右侧图标墙",
        performance: "王杰本人出镜并使用本人原声；前半句像承认失误，后半句加重并停半拍",
        props: ["电脑", "自制工具图标卡"],
        lighting: "左前方 45 度柔光，背景灯压低一档",
        audioCapture: "领夹麦主收音，录十秒环境底噪",
        continuity: "右手指向动作在句尾保持一秒，便于切 B-roll",
        alternatives: ["若空间不足，改用半身正中构图并把大字放上方"],
      },
      {
        slug: "target-method",
        timelineIn: 5,
        timelineOut: 12,
        lineSlugs: ["line-method"],
        referenceShotSlugs: ["cost-reveal"],
        scene: "同一书桌，切到自有工具清单",
        framing: "屏幕录制为主，左下角保留人物圆角画中画",
        composition: "三项筛选标准纵向排列，每说一项点亮一项",
        cameraPosition: "正面屏幕录制，人物机位保持不变",
        cameraMovement: "列表随台词逐项高亮，不滚动页面",
        subjectAction: "鼠标依次点亮任务、复用、产出三行",
        performance: "语速放慢，每项落词清楚，最后一句收稳",
        props: ["自有工具清单页面"],
        lighting: "画中画沿用主镜头光线与白平衡",
        audioCapture: "沿用主录音；鼠标点击声后期单独补",
        continuity: "第一项出现前保留半秒空白界面",
        alternatives: ["无法录屏时用三张实体卡片依次翻开"],
      },
    ],
    editBlueprint: [
      {
        shootingShotSlug: "target-hook",
        referenceMechanisms: ["反问式矛盾在第一拍出现", "关键落词轻推近"],
        cutStrategy: "0 秒直接进入，不加片头；句尾动作保持后硬切",
        pacing: "前 5 秒只保留一个主镜头，用文字和推近制造变化",
        brollSlots: [
          {
            trigger: "十几个 AI 工具",
            purpose: "证明工具堆叠",
            visual: "本人实际使用的工具图标墙",
            sourceStrategy: "self_recorded",
            sourcePlan: { provenance: "本人实拍", rightsStatus: "user_owned" },
            generation: null,
            durationSeconds: 1.6,
            reviewBeforeUse: true,
          },
        ],
        motionGraphics: [
          { trigger: "更慢了", purpose: "强化反差", visual: "工具图标向两侧退开，慢字落到视觉中心", durationSeconds: 0.8 },
        ],
        sfx: [{ trigger: "更慢了", sound: "短促下落音", mix: "低于人声 12dB" }],
        music: { cue: "第一帧进入", mood: "克制的电子节奏", change: "更慢了之后削弱鼓点" },
        transition: "保持右手指向动作，硬切到右侧清单",
        keyFrames: ["00:00.000 人脸和钩子大字同时清楚", "00:04.600 推近结束且字幕不遮脸"],
        acceptance: ["前三秒能看懂矛盾", "没有复制原片台词或画面"],
      },
      {
        shootingShotSlug: "target-method",
        referenceMechanisms: ["把抽象结论拆成逐项可见证据"],
        cutStrategy: "每个筛选项在对应名词落下时点亮，不抢先出现",
        pacing: "每项约两秒，结论留一秒完整停顿",
        brollSlots: [
          {
            trigger: "高频任务",
            purpose: "展示真实使用证据",
            visual: "本人一周任务统计",
            sourceStrategy: "self_recorded",
            sourcePlan: { provenance: "本人脱敏后的工具清单和自有视觉标识录屏", rightsStatus: "user_owned" },
            generation: null,
            durationSeconds: 1.5,
            reviewBeforeUse: true,
          },
          {
            trigger: "真实产出",
            purpose: "把抽象的产出结果变成可见场景",
            visual: "横屏办公桌俯拍，已完成的课程大纲、视频时间线和客户沟通清单依次被勾选",
            sourceStrategy: "generated_after_approval",
            sourcePlan: { provenance: "MiniMax 生成候选，待预览审核", rightsStatus: "pending_generation" },
            generation: {
              executor: "minimax-broll-generator",
              model: "MiniMax-H3",
              mode: "T2VA",
              prompt: "16:9 横屏写实办公场景，俯拍深绿色桌面，三张真实质感的工作卡片依次被一只成年男性的手勾选：课程大纲、视频时间线、客户沟通清单。镜头固定，动作分三拍发生，文字区域保持清晰但不出现品牌 Logo，柔和左侧主光，节奏克制，最后停在三项全部完成的俯拍画面。",
            },
            durationSeconds: 2,
            reviewBeforeUse: true,
          },
        ],
        motionGraphics: [
          { trigger: "三件事", purpose: "建立信息层级", visual: "1 任务、2 复用、3 产出三行依次点亮", durationSeconds: 5 },
        ],
        sfx: [{ trigger: "每项点亮", sound: "三次同音色轻点击", mix: "低于人声 16dB" }],
        music: { cue: "延续上一镜", mood: "稳定", change: "最后一句前降低 3dB" },
        transition: "结论停一秒后淡出，不加模板片尾",
        keyFrames: ["00:07.000 第一项点亮", "00:11.000 三项均清晰且人物画中画无遮挡"],
        acceptance: ["三项与台词逐项同步", "自有数据可辨认但敏感信息已遮挡"],
      },
    ],
  };
}

async function setupReference(tempRoot: string) {
  const projectDir = path.join(tempRoot, "project");
  const referencePath = path.join(tempRoot, "reference.mp4");
  const targetPath = path.join(tempRoot, "target.mp4");
  createFixture(referencePath);
  const init = runCli([
    "init", "--project", projectDir, "--title", "参考视频原创仿拍", "--lane", "speech", "--source", targetPath,
    "--aspect-ratio", "16:9",
  ]);
  assert.equal(init.status, 0, init.stderr);
  const ingest = runCli([
    "ingest", "--project", projectDir, "--asset", referencePath, "--role", "reference", "--provenance", "public-reference",
  ]);
  assert.equal(ingest.status, 0, ingest.stderr);
  const assetId = JSON.parse(ingest.stdout).assetId as string;
  const analysisInputPath = path.join(tempRoot, "reference-input.json");
  await writeFile(analysisInputPath, `${JSON.stringify(referenceInput(), null, 2)}\n`, "utf8");
  return { projectDir, referencePath, targetPath, assetId, analysisInputPath };
}

async function prepareApprovedPlan(tempRoot: string) {
  const setup = await setupReference(tempRoot);
  assert.equal(runCli([
    "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
  ]).status, 0);
  assert.equal(runCli([
    "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
  ]).status, 0);
  const planInputPath = path.join(tempRoot, "recreation-input.json");
  await writeFile(planInputPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
  assert.equal(runCli(["plan-recreation", "--project", setup.projectDir, "--input", planInputPath]).status, 0);
  assert.equal(runCli([
    "review-recreation", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
  ]).status, 0);
  return setup;
}

async function prepareApplication(tempRoot: string) {
  const setup = await prepareApprovedPlan(tempRoot);
  createFixture(setup.targetPath, "green", 660);
  assert.equal(runCli([
    "ingest", "--project", setup.projectDir, "--asset", setup.targetPath, "--role", "a-roll", "--provenance", "user-owned",
  ]).status, 0);
  const projectPath = path.join(setup.projectDir, "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.workflowStatus = "plan_ready";
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

  const cutPlanPath = path.join(setup.projectDir, "cut-plan.json");
  const transcriptPath = path.join(setup.projectDir, "transcript.json");
  const editPlanPath = path.join(setup.projectDir, "edit-plan.json");
  const approvedPlan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
  const targetLines = approvedPlan.targetVerbatimScript as Array<{ text: string }>;
  await writeFile(transcriptPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    sourceAssetId: "asset_target_recording",
    engine: "human-verified-test",
    language: "zh",
    segments: [
      { id: "seg_target_hook", text: targetLines[0].text, start: 0, end: 5, wordIds: [] },
      { id: "seg_target_method", text: targetLines[1].text, start: 5, end: 12, wordIds: [] },
    ],
    words: [],
  }, null, 2)}\n`, "utf8");
  const cutPlan = JSON.parse(await readFile(cutPlanPath, "utf8"));
  cutPlan.transcriptHash = await sha256Path(transcriptPath);
  cutPlan.reviewStatus = "approved";
  cutPlan.operations = [
    { id: "op_target_hook", kind: "speech", decision: "keep", segmentId: "seg_target_hook", transcript: targetLines[0].text },
    { id: "op_target_method", kind: "speech", decision: "keep", segmentId: "seg_target_method", transcript: targetLines[1].text },
  ];
  await writeFile(cutPlanPath, `${JSON.stringify(cutPlan, null, 2)}\n`, "utf8");
  await writeFile(editPlanPath, `${JSON.stringify({
    schemaVersion: "1.0.0",
    cutPlanHash: await sha256Path(cutPlanPath),
    reviewStatus: "ready",
    shots: [
      { id: "shot_target_hook", cutOperationId: "op_target_hook", voiceover: targetLines[0].text, semanticIntent: "目标钩子", visualRole: "a-roll" },
      { id: "shot_target_method", cutOperationId: "op_target_method", voiceover: targetLines[1].text, semanticIntent: "目标方法", visualRole: "screen-and-a-roll" },
    ],
  }, null, 2)}\n`, "utf8");
  const mappingPath = path.join(tempRoot, "mapping.json");
  await writeFile(mappingPath, `${JSON.stringify({
    recreationPlanContentHash: approvedPlan.contentHash,
    targetTranscriptHash: await sha256Path(transcriptPath),
    cutPlanHash: await sha256Path(cutPlanPath),
    editPlanHash: await sha256Path(editPlanPath),
    reviewer: "Codex",
    mappings: [
      { recreationShotId: approvedPlan.shootingPlan[0].id, editShotId: "shot_target_hook" },
      { recreationShotId: approvedPlan.shootingPlan[1].id, editShotId: "shot_target_method" },
    ],
  }, null, 2)}\n`, "utf8");
  return { ...setup, cutPlanPath, editPlanPath, mappingPath };
}

test("reference recreation keeps source evidence, target script, shooting plan, and edit recipe separate", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-recreation-"));
  try {
    const setup = await setupReference(tempRoot);
    const beforeTargetTranscript = await readFile(path.join(setup.projectDir, "transcript.json"), "utf8");

    const analyzed = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const analysis = JSON.parse(await readFile(path.join(setup.projectDir, "reference-analysis.json"), "utf8"));
    assert.equal(analysis.status, "needs_review");
    assert.equal(analysis.referenceVerbatimTranscript.segments.length, 2);
    assert.match(analysis.referenceVerbatimTranscript.segments[0].id, /^rseg_[a-f0-9]{20}$/);
    assert.match(analysis.shots[0].id, /^rshot_[a-f0-9]{20}$/);
    assert.equal(await readFile(path.join(setup.projectDir, "transcript.json"), "utf8"), beforeTargetTranscript);

    const reviewed = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
      "--notes", "逐字稿与镜头边界已对照原片复核",
    ]);
    assert.equal(reviewed.status, 0, reviewed.stderr);

    const planInputPath = path.join(tempRoot, "recreation-input.json");
    await writeFile(planInputPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
    const planned = runCli([
      "plan-recreation", "--project", setup.projectDir, "--input", planInputPath,
    ]);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(plan.status, "pending_user_review");
    assert.equal(plan.targetVerbatimScript.length, 2);
    assert.notEqual(plan.targetVerbatimScript[0].text, analysis.referenceVerbatimTranscript.segments[0].text);
    assert.equal(plan.shootingPlan.length, 2);
    assert.equal(plan.editBlueprint.length, 2);
    assert.equal(plan.selectedOptionSlug, "balanced-evidence");
    assert.match(plan.targetVerbatimScript[0].id, /^tline_[a-f0-9]{20}$/);

    const board = await readFile(path.join(setup.projectDir, "recreation-board.md"), "utf8");
    assert.match(board, /\| 时间 \| 目标逐字稿 \|/);
    assert.match(board, /B-roll/);
    assert.match(board, /方案选择/);
    assert.match(board, /完整拍摄执行表/);
    assert.match(board, /B-roll 资产与生成提示词审批表/);
    assert.match(board, /minimax-broll-generator/);
    assert.match(board, /MiniMax-H3/);
    assert.match(board, /16:9 横屏写实办公场景/);
    assert.match(board, /promptHash=/);
    assert.match(board, /受保护元素替换与授权核对/);
    const teleprompter = await readFile(path.join(setup.projectDir, "teleprompter.txt"), "utf8");
    assert.match(teleprompter, /我装了十几个 AI 工具/);
    assert.doesNotMatch(teleprompter, /都说AI能省钱/);

    const planReviewed = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
      "--notes", "同意按该横屏拍摄表执行",
    ]);
    assert.equal(planReviewed.status, 0, planReviewed.stderr);

    createFixture(setup.targetPath, "green", 660);
    const targetIngest = runCli([
      "ingest", "--project", setup.projectDir, "--asset", setup.targetPath, "--role", "a-roll", "--provenance", "user-owned",
    ]);
    assert.equal(targetIngest.status, 0, targetIngest.stderr);
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "plan_ready";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const cutPlanPath = path.join(setup.projectDir, "cut-plan.json");
    const transcriptPath = path.join(setup.projectDir, "transcript.json");
    const editPlanPath = path.join(setup.projectDir, "edit-plan.json");
    const approvedPlan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    const targetLines = approvedPlan.targetVerbatimScript as Array<{ text: string }>;
    await writeFile(transcriptPath, `${JSON.stringify({
      schemaVersion: "1.0.0",
      segments: [
        { id: "seg_target_hook", text: targetLines[0].text, start: 0, end: 5, wordIds: [] },
        { id: "seg_target_method", text: targetLines[1].text, start: 5, end: 12, wordIds: [] },
      ],
      words: [],
    }, null, 2)}\n`, "utf8");
    const currentCutPlan = JSON.parse(await readFile(cutPlanPath, "utf8"));
    currentCutPlan.transcriptHash = await sha256Path(transcriptPath);
    currentCutPlan.reviewStatus = "approved";
    currentCutPlan.operations = [
      { id: "op_target_hook", kind: "speech", decision: "keep", segmentId: "seg_target_hook", transcript: targetLines[0].text },
      { id: "op_target_method", kind: "speech", decision: "keep", segmentId: "seg_target_method", transcript: targetLines[1].text },
    ];
    await writeFile(cutPlanPath, `${JSON.stringify(currentCutPlan, null, 2)}\n`, "utf8");
    const currentCutPlanHash = await sha256Path(cutPlanPath);
    await writeFile(
      editPlanPath,
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        cutPlanHash: currentCutPlanHash,
        reviewStatus: "ready",
        shots: [
          { id: "shot_target_hook", cutOperationId: "op_target_hook", voiceover: targetLines[0].text, semanticIntent: "目标钩子", visualRole: "a-roll" },
          { id: "shot_target_method", cutOperationId: "op_target_method", voiceover: targetLines[1].text, semanticIntent: "目标方法", visualRole: "screen-and-a-roll" },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const transcriptBeforeApply = await readFile(transcriptPath, "utf8");
    const cutBeforeApply = await readFile(cutPlanPath, "utf8");
    const mappingPath = path.join(tempRoot, "mapping.json");
    await writeFile(
      mappingPath,
      `${JSON.stringify({
        recreationPlanContentHash: approvedPlan.contentHash,
        targetTranscriptHash: await sha256Path(transcriptPath),
        cutPlanHash: await sha256Path(cutPlanPath),
        editPlanHash: await sha256Path(editPlanPath),
        reviewer: "Codex",
        mappings: [
          { recreationShotId: approvedPlan.shootingPlan[0].id, editShotId: "shot_target_hook" },
          { recreationShotId: approvedPlan.shootingPlan[1].id, editShotId: "shot_target_method" },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const applied = runCli([
      "apply-recreation", "--project", setup.projectDir, "--input", mappingPath,
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const editPlan = JSON.parse(await readFile(path.join(setup.projectDir, "edit-plan.json"), "utf8"));
    assert.equal(editPlan.shots[0].referenceRecreation.brollSlots[0].reviewBeforeUse, true);
    assert.equal(editPlan.shots[1].referenceRecreation.motionGraphics.length, 1);
    assert.equal(await readFile(transcriptPath, "utf8"), transcriptBeforeApply);
    assert.equal(await readFile(cutPlanPath, "utf8"), cutBeforeApply);
    const applicationJournal = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-application.json"), "utf8"));
    assert.equal(applicationJournal.status, "completed");
    assert.match(applicationJournal.editPlanAfterHash, /^[a-f0-9]{64}$/);

    const validated = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(validated.stdout).filesChecked, 12);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan-recreation blocks unlicensed reuse of the reference wording", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-copy-"));
  try {
    const setup = await setupReference(tempRoot);
    const analyzed = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const reviewed = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const copiedPath = path.join(tempRoot, "copied-plan.json");
    const copied = recreationInput(true);
    copied.adaptationPolicy.replacementMap[0].replacement = "改写后的目标句以‘都说 AI’开头";
    copied.adaptationPolicy.replacementMap[0].replacementAnchors = ["都说 AI"];
    await writeFile(copiedPath, `${JSON.stringify(copied, null, 2)}\n`, "utf8");
    const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", copiedPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /copies reference wording/i);
    await assert.rejects(readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("reference approval fails when the registered video bytes drift", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-drift-"));
  try {
    const setup = await setupReference(tempRoot);
    const analyzed = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    await appendFile(setup.referencePath, "drift", "utf8");
    const review = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(review.status, 1);
    assert.match(review.stderr, /reference video changed/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan-recreation detects copied wording even when the reference sentence is split across target lines", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-split-copy-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const split = recreationInput() as ReturnType<typeof recreationInput>;
    split.targetVerbatimScript[0].text = "都说 AI 能";
    split.targetVerbatimScript[1].text = "省钱，我怎么越花越多";
    split.adaptationPolicy.replacementMap[0].replacement = "目标第一句以‘都说 AI’开头";
    split.adaptationPolicy.replacementMap[0].replacementAnchors = ["都说 AI"];
    split.adaptationPolicy.replacementMap[3].replacement = "目标第二句以‘越花越多’收尾";
    split.adaptationPolicy.replacementMap[3].replacementAnchors = ["越花越多"];
    const planPath = path.join(tempRoot, "split-copy.json");
    await writeFile(planPath, `${JSON.stringify(split, null, 2)}\n`, "utf8");
    const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /copies reference wording/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan-recreation detects visually identical copied wording separated by zero-width characters", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-zero-width-copy-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const copied = recreationInput(true);
    copied.targetVerbatimScript[0].text = [...copied.targetVerbatimScript[0].text].join("\u200B");
    copied.adaptationPolicy.replacementMap[0].replacement = "改写后的目标句以‘都说 AI’开头";
    copied.adaptationPolicy.replacementMap[0].replacementAnchors = ["都说 AI"];
    const planPath = path.join(tempRoot, "zero-width-copy.json");
    await writeFile(planPath, `${JSON.stringify(copied, null, 2)}\n`, "utf8");
    const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /copies reference wording/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("withdrawing reference approval requires its recreation plan to be withdrawn first", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-revoked-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const planInputPath = path.join(tempRoot, "plan.json");
    await writeFile(planInputPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
    assert.equal(runCli(["plan-recreation", "--project", setup.projectDir, "--input", planInputPath]).status, 0);
    const blockedReferenceWithdrawal = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "Codex", "--authority", "operator",
    ]);
    assert.equal(blockedReferenceWithdrawal.status, 1);
    assert.match(blockedReferenceWithdrawal.stderr, /dependent recreation plan.*withdrawn first/i);
    const stillApprovedReference = JSON.parse(await readFile(path.join(setup.projectDir, "reference-analysis.json"), "utf8"));
    const stillPendingPlan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(stillApprovedReference.status, "approved");
    assert.equal(stillPendingPlan.status, "pending_user_review");

    const planWithdrawal = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "Codex", "--authority", "operator",
    ]);
    assert.equal(planWithdrawal.status, 0, planWithdrawal.stderr);
    const withdrawnPlan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(withdrawnPlan.status, "needs_revision");
    assert.equal((JSON.parse(await readFile(path.join(setup.projectDir, "reference-analysis.json"), "utf8")) as { status: string }).status, "approved");

    const referenceWithdrawal = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "Codex", "--authority", "operator",
    ]);
    assert.equal(referenceWithdrawal.status, 0, referenceWithdrawal.stderr);
    const withdrawnReference = JSON.parse(await readFile(path.join(setup.projectDir, "reference-analysis.json"), "utf8"));
    assert.equal(withdrawnReference.status, "needs_revision");
    assert.equal((JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8")) as { status: string }).status, "needs_revision");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("close recreation cannot be unlocked by self-declared text or an analysis-only reference", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-rights-"));
  try {
    const setup = await setupReference(tempRoot);
    const analysisOnly = referenceInput();
    analysisOnly.intendedUse = "analysis_only";
    await writeFile(setup.analysisInputPath, `${JSON.stringify(analysisOnly, null, 2)}\n`, "utf8");
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const closePlan = recreationInput() as any;
    closePlan.adaptationPolicy.mode = "authorized_close_recreation";
    closePlan.adaptationPolicy.authorizationEvidence = [{
      path: "self-declared.txt",
      sha256: "0".repeat(64),
      authorizedBy: "unknown",
      verifiedBy: "Codex",
      verifiedAt: "2026-09-27T00:00:00.000Z",
      scope: ["close_recreation"],
    }];
    closePlan.targetVerbatimScript[0].text = "都说AI能省钱";
    const closePath = path.join(tempRoot, "close.json");
    await writeFile(closePath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", closePath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restricted to analysis_only/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("reference transcript evidence cannot extend past the video duration", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-word-range-"));
  try {
    const setup = await setupReference(tempRoot);
    const invalid = referenceInput();
    invalid.referenceVerbatimTranscript.words[4].end = 2;
    await writeFile(setup.analysisInputPath, `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
    const result = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extends past the registered media duration/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("analyze-reference requires non-empty word-level transcript evidence", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-words-required-"));
  try {
    const setup = await setupReference(tempRoot);
    const invalid = referenceInput();
    invalid.referenceVerbatimTranscript.words = [];
    await writeFile(setup.analysisInputPath, `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
    const result = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /words must be a non-empty array/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("review commands reject authority values outside user and operator", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-authority-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    const operatorApproval = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "Codex", "--authority", "operator",
    ]);
    assert.equal(operatorApproval.status, 1);
    assert.match(operatorApproval.stderr, /approval is a user gate/i);
    const referenceReview = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "Codex", "--authority", "admin",
    ]);
    assert.equal(referenceReview.status, 1);
    assert.match(referenceReview.stderr, /unsupported review authority: admin/i);

    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const planPath = path.join(tempRoot, "plan.json");
    await writeFile(planPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
    assert.equal(runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]).status, 0);
    const recreationReview = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "Codex", "--authority", "service",
    ]);
    assert.equal(recreationReview.status, 1);
    assert.match(recreationReview.stderr, /unsupported review authority: service/i);
    const operatorRecreationApproval = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "Codex", "--authority", "operator",
    ]);
    assert.equal(operatorRecreationApproval.status, 1);
    assert.match(operatorRecreationApproval.stderr, /approval is a user gate/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("close-recreation authorization evidence requires a named verifier and valid verification time", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-rights-verification-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const analysis = JSON.parse(await readFile(path.join(setup.projectDir, "reference-analysis.json"), "utf8"));

    const missingVerifier = recreationInput() as any;
    missingVerifier.adaptationPolicy.mode = "authorized_close_recreation";
    missingVerifier.adaptationPolicy.authorizationEvidence = [{
      path: "authorization.txt",
      sha256: "0".repeat(64),
      referenceAssetSha256: analysis.source.sha256,
      authorizedBy: "rights-owner",
      rightsHolder: "rights-owner",
      authorizedElements: ["原作者台词"],
      verifiedAt: "2026-09-27T00:00:00.000Z",
      scope: ["close_recreation"],
    }];
    const missingVerifierPath = path.join(tempRoot, "missing-verifier.json");
    await writeFile(missingVerifierPath, `${JSON.stringify(missingVerifier, null, 2)}\n`, "utf8");
    const missingResult = runCli(["plan-recreation", "--project", setup.projectDir, "--input", missingVerifierPath]);
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /verifiedBy must be non-empty text/i);

    const invalidTime = recreationInput() as any;
    invalidTime.adaptationPolicy.mode = "authorized_close_recreation";
    invalidTime.adaptationPolicy.authorizationEvidence = [{
      path: "authorization.txt",
      sha256: "0".repeat(64),
      referenceAssetSha256: analysis.source.sha256,
      authorizedBy: "rights-owner",
      rightsHolder: "rights-owner",
      authorizedElements: ["原作者台词"],
      verifiedBy: "Codex",
      verifiedAt: "not-a-timestamp",
      scope: ["close_recreation"],
    }];
    const invalidTimePath = path.join(tempRoot, "invalid-verification-time.json");
    await writeFile(invalidTimePath, `${JSON.stringify(invalidTime, null, 2)}\n`, "utf8");
    const invalidTimeResult = runCli(["plan-recreation", "--project", setup.projectDir, "--input", invalidTimePath]);
    assert.equal(invalidTimeResult.status, 1);
    assert.match(invalidTimeResult.stderr, /verifiedAt must be an ISO-8601 timestamp/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plan-recreation checks reference wording in outline, B-roll, and motion-graphic visible text", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-visible-copy-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);

    const cases: Array<{ label: string; mutate: (input: ReturnType<typeof recreationInput>) => void }> = [
      {
        label: "outline",
        mutate: (input) => { input.scriptOutline[0].targetMessage = "都说AI能省钱，我怎么越花越多"; },
      },
      {
        label: "broll",
        mutate: (input) => { input.editBlueprint[0].brollSlots[0].visual = "都说AI能省钱，我怎么越花越多"; },
      },
      {
        label: "motion-graphic",
        mutate: (input) => { input.editBlueprint[0].motionGraphics[0].visual = "都说AI能省钱，我怎么越花越多"; },
      },
    ];
    for (const candidate of cases) {
      const copied = recreationInput();
      candidate.mutate(copied);
      const inputPath = path.join(tempRoot, `${candidate.label}.json`);
      await writeFile(inputPath, `${JSON.stringify(copied, null, 2)}\n`, "utf8");
      const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", inputPath]);
      assert.equal(result.status, 1, `${candidate.label}: ${result.stderr}`);
      assert.match(result.stderr, /copies reference wording/i, candidate.label);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("apply-recreation rejects stale cut-plan and edit-plan hashes", async (context) => {
  for (const target of ["cut", "edit"] as const) {
    await context.test(target, async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), `video-flow-reference-stale-${target}-`));
      try {
        const setup = await prepareApplication(tempRoot);
        const driftPath = target === "cut" ? setup.cutPlanPath : setup.editPlanPath;
        const drifted = JSON.parse(await readFile(driftPath, "utf8"));
        drifted.testDrift = target;
        await writeFile(driftPath, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
        const result = runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(`stale: ${target} plan changed`, "i"));
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("reference and recreation reviews cannot change an archived project", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-archived-review-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const planPath = path.join(tempRoot, "plan.json");
    await writeFile(planPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
    assert.equal(runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]).status, 0);

    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "archived";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

    const referenceReview = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "Codex", "--authority", "operator",
    ]);
    assert.equal(referenceReview.status, 1);
    assert.match(referenceReview.stderr, /cannot change an archived project/i);
    const recreationReview = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(recreationReview.status, 1);
    assert.match(recreationReview.stderr, /cannot change an archived project/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("analysis_only references cannot enter any recreation mode", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-analysis-only-"));
  try {
    const setup = await setupReference(tempRoot);
    const analysisOnly = referenceInput();
    analysisOnly.intendedUse = "analysis_only";
    await writeFile(setup.analysisInputPath, `${JSON.stringify(analysisOnly, null, 2)}\n`, "utf8");
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const planPath = path.join(tempRoot, "plan.json");
    await writeFile(planPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
    const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restricted to analysis_only/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("recreation plan enforces project platform, aspect ratio, and exact target-line coverage", async (context) => {
  for (const target of ["platform", "aspect", "line-coverage"] as const) {
    await context.test(target, async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), `video-flow-reference-${target}-`));
      try {
        const setup = await setupReference(tempRoot);
        assert.equal(runCli([
          "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
        ]).status, 0);
        assert.equal(runCli([
          "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
        ]).status, 0);
        const plan = recreationInput();
        if (target === "platform") plan.brief.platform = "抖音";
        else if (target === "aspect") plan.brief.aspectRatio = "9:16";
        else plan.shootingPlan[1].lineSlugs = ["line-hook"];
        const planPath = path.join(tempRoot, `${target}.json`);
        await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          target === "platform"
            ? /does not match project platform/i
            : target === "aspect"
              ? /does not match project output/i
              : /exactly one shooting shot/i,
        );
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("an approved recreation becomes stale when the project platform changes", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-platform-drift-"));
  try {
    const setup = await prepareApprovedPlan(tempRoot);
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.platform = "抖音";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const validated = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validated.status, 1);
    assert.match(validated.stderr, /platform no longer matches|does not match project platform/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("licensed B-roll evidence is file- and hash-bound after planning", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-license-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const licensePath = path.join(tempRoot, "stock-license.txt");
    await writeFile(licensePath, "licensed for this production\n", "utf8");
    const stockPath = path.join(tempRoot, "licensed-stock.mp4");
    createFixture(stockPath, "purple", 550);
    const stockIngest = runCli([
      "ingest", "--project", setup.projectDir, "--asset", stockPath, "--role", "b-roll", "--provenance", "licensed",
    ]);
    assert.equal(stockIngest.status, 0, stockIngest.stderr);
    const stockAssetId = JSON.parse(stockIngest.stdout).assetId as string;
    const plan = recreationInput();
    const slot = plan.editBlueprint[0].brollSlots[0] as any;
    slot.sourceStrategy = "licensed_stock";
    slot.sourcePlan = {
      provenance: "licensed stock vendor",
      rightsStatus: "licensed",
      licenseEvidencePath: licensePath,
      licenseEvidenceSha256: await sha256Path(licensePath),
      assetId: stockAssetId,
      assetSha256: await sha256Path(stockPath),
    };
    const planPath = path.join(tempRoot, "licensed-plan.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    assert.equal(runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]).status, 0);
    await appendFile(licensePath, "drift", "utf8");
    const review = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(review.status, 1);
    assert.match(review.stderr, /evidence hash changed/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("apply-recreation rejects a Cut Plan that no longer binds the target transcript", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-transcript-chain-"));
  try {
    const setup = await prepareApplication(tempRoot);
    const transcriptPath = path.join(setup.projectDir, "transcript.json");
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    transcript.testDrift = "new transcript bytes";
    await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    const mapping = JSON.parse(await readFile(setup.mappingPath, "utf8"));
    mapping.targetTranscriptHash = await sha256Path(transcriptPath);
    await writeFile(setup.mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    const result = runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cut-plan\.json to bind the current transcript/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("revising an applied recreation removes its active Edit Plan bindings before approval withdrawal", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-revoke-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const revoked = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
      "--notes", "撤回该仿拍方案",
    ]);
    assert.equal(revoked.status, 0, revoked.stderr);
    const editPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
    assert.equal(editPlan.referenceRecreationApplication, undefined);
    assert.equal(editPlan.shots.some((shot: any) => shot.referenceRecreation), false);
    assert.equal(editPlan.referenceRecreationRevocation.planContentHash.length, 64);
    const plan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(plan.status, "needs_revision");
    assert.equal(plan.approvedContentHash, null);
    const referenceRevoked = runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(referenceRevoked.status, 0, referenceRevoked.stderr);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("apply-recreation recovers the same pending transaction after the Edit Plan was already written", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-recover-"));
  try {
    const setup = await prepareApplication(tempRoot);
    const first = runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]);
    assert.equal(first.status, 0, first.stderr);
    const journalPath = path.join(setup.projectDir, "recreation-application.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.status = "pending";
    delete journal.editPlanAfterHash;
    delete journal.completedAt;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const planPath = path.join(setup.projectDir, "recreation-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.status = "approved";
    plan.applications = [];
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const recovered = runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recovered, true);
    const recoveredJournal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(recoveredJournal.status, "completed");
    const recoveredPlan = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(recoveredPlan.status, "applied");
    assert.equal(recoveredPlan.applications.length, 1);
    const validated = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validated.status, 0, validated.stderr);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("reference word evidence must reconstruct its transcript segment", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-word-text-"));
  try {
    const setup = await setupReference(tempRoot);
    const invalid = referenceInput();
    invalid.referenceVerbatimTranscript.words[2].text = "会花钱";
    await writeFile(setup.analysisInputPath, `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
    const result = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /do not reconstruct transcript segment/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("user approval rejects drifted Markdown and teleprompter review artifacts", async (context) => {
  for (const target of ["reference-board", "recreation-board", "teleprompter"] as const) {
    await context.test(target, async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), `video-flow-reference-review-drift-${target}-`));
      try {
        const setup = await setupReference(tempRoot);
        assert.equal(runCli([
          "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
        ]).status, 0);
        if (target === "reference-board") {
          await appendFile(path.join(setup.projectDir, "reference-analysis.md"), "\n隐藏变更\n", "utf8");
          const result = runCli([
            "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
          ]);
          assert.equal(result.status, 1);
          assert.match(result.stderr, /review artifact drifted/i);
          return;
        }
        assert.equal(runCli([
          "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
        ]).status, 0);
        const planPath = path.join(tempRoot, "plan.json");
        await writeFile(planPath, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
        assert.equal(runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]).status, 0);
        const driftPath = path.join(
          setup.projectDir,
          target === "recreation-board" ? "recreation-board.md" : "teleprompter.txt",
        );
        await appendFile(driftPath, "\n隐藏变更\n", "utf8");
        const result = runCli([
          "review-recreation", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
        ]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /drifted from the hash-bound JSON contract/i);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("replacementMap target paths must resolve to real approved target fields", async (context) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-target-paths-"));
  try {
    const setup = await setupReference(tempRoot);
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);

    const cases: Array<{ label: string; expected: RegExp; mutate: (plan: any) => void }> = [
      {
        label: "missing",
        expected: /must be a non-empty array|bind at least one target path/i,
        mutate: (plan) => { plan.adaptationPolicy.replacementMap[0].targetPaths = []; },
      },
      {
        label: "wrong-root",
        expected: /outside approved target fields/i,
        mutate: (plan) => { plan.adaptationPolicy.replacementMap[0].targetPaths = ["/creativeOptions/0/coreIdea"]; },
      },
      {
        label: "unresolved",
        expected: /does not resolve/i,
        mutate: (plan) => { plan.adaptationPolicy.replacementMap[0].targetPaths = ["/targetVerbatimScript/99/text"]; },
      },
      {
        label: "still-protected",
        expected: /still contains protected element/i,
        mutate: (plan) => { plan.targetVerbatimScript[0].text = "原作者台词直接复用"; },
      },
      {
        label: "semantic-mismatch",
        expected: /do not evidence replacement anchor/i,
        mutate: (plan) => {
          const mapping = plan.adaptationPolicy.replacementMap.find((item: any) => item.sourceElement === "品牌元素");
          mapping.targetPaths = ["/brief/objective"];
        },
      },
    ];
    for (const candidate of cases) {
      await context.test(candidate.label, async () => {
        const plan = recreationInput() as any;
        candidate.mutate(plan);
        const planPath = path.join(tempRoot, `${candidate.label}.json`);
        await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        const result = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, candidate.expected);
      });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("licensed_reuse is authorized element by element", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-element-rights-"));
  try {
    const setup = await setupReference(tempRoot);
    const assetsPath = path.join(setup.projectDir, "assets.json");
    const assets = JSON.parse(await readFile(assetsPath, "utf8"));
    assets.assets.find((asset: any) => asset.assetId === setup.assetId).rights.status = "cleared";
    await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`, "utf8");
    const closeReference = referenceInput();
    closeReference.intendedUse = "authorized_close_recreation";
    await writeFile(setup.analysisInputPath, `${JSON.stringify(closeReference, null, 2)}\n`, "utf8");
    assert.equal(runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]).status, 0);
    assert.equal(runCli([
      "review-reference", "--project", setup.projectDir, "--decision", "approve", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const analysis = JSON.parse(await readFile(path.join(setup.projectDir, "reference-analysis.json"), "utf8"));
    const evidencePath = path.join(tempRoot, "authorization.txt");
    await writeFile(evidencePath, "rights-holder authorizes selected elements\n", "utf8");
    const closePlan = recreationInput() as any;
    closePlan.adaptationPolicy.mode = "authorized_close_recreation";
    closePlan.adaptationPolicy.replacementMap.find((item: any) => item.sourceElement === "原作者身份").action = "licensed_reuse";
    closePlan.adaptationPolicy.authorizationEvidence = [{
      path: evidencePath,
      sha256: await sha256Path(evidencePath),
      referenceAssetSha256: analysis.source.sha256,
      authorizedBy: "rights-owner",
      rightsHolder: "rights-owner",
      authorizedElements: ["原作者台词"],
      verifiedBy: "Codex",
      verifiedAt: "2026-09-27T00:00:00.000Z",
      scope: ["close_recreation"],
    }];
    const planPath = path.join(tempRoot, "close-plan.json");
    await writeFile(planPath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    const unauthorized = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
    assert.equal(unauthorized.status, 1);
    assert.match(unauthorized.stderr, /not authorized for sourceElement: 原作者身份/i);

    closePlan.adaptationPolicy.authorizationEvidence[0].authorizedElements.push("原作者身份");
    await writeFile(planPath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    const authorized = runCli(["plan-recreation", "--project", setup.projectDir, "--input", planPath]);
    assert.equal(authorized.status, 0, authorized.stderr);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validate detects applied recreation binding drift and malformed application evidence", async (context) => {
  for (const target of ["binding", "application"] as const) {
    await context.test(target, async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), `video-flow-reference-applied-drift-${target}-`));
      try {
        const setup = await prepareApplication(tempRoot);
        assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
        if (target === "binding") {
          const editPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
          editPlan.shots[0].referenceRecreation.shooting.scene = "未审批的替换场景";
          await writeFile(setup.editPlanPath, `${JSON.stringify(editPlan, null, 2)}\n`, "utf8");
        } else {
          const planPath = path.join(setup.projectDir, "recreation-plan.json");
          const plan = JSON.parse(await readFile(planPath, "utf8"));
          delete plan.applications[0].referenceBindingsHash;
          await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        }
        const validated = runCli(["validate", "--project", setup.projectDir]);
        assert.equal(validated.status, 1);
        assert.match(
          validated.stderr,
          target === "binding" ? /binding drifted/i : /referenceBindingsHash|application referenceBindingsHash is stale/i,
        );
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("validate rejects transcript drift after a recreation plan was applied", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-transcript-drift-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const transcriptPath = path.join(setup.projectDir, "transcript.json");
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    transcript.segments[0].text = "未经过重新审批的目标台词";
    await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

    const validated = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validated.status, 1);
    assert.match(validated.stderr, /targetTranscriptHash is stale|current transcript|Transcript segment/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("revising an applied recreation invalidates downstream review evidence and final confirmation", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-downstream-invalidation-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const projectPath = path.join(setup.projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.workflowStatus = "final_confirmed";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const reviewPath = path.join(setup.projectDir, "review.json");
    await writeFile(reviewPath, `${JSON.stringify({
      schemaVersion: "1.0.0",
      versions: [{
        versionId: "version_final_candidate_test",
        stage: "final_candidate",
        label: "已确认定稿",
        filePath: setup.targetPath,
        sha256: await sha256Path(setup.targetPath),
        sizeBytes: 1,
        evidenceStatus: "valid",
        userStatus: "confirmed",
        recordedAt: "2026-09-27T00:00:00.000Z",
      }],
      confirmations: [{ gate: "final", versionId: "version_final_candidate_test", decision: "approve" }],
    }, null, 2)}\n`, "utf8");

    const revised = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
      "--notes", "仿拍蓝图需要重做",
    ]);
    assert.equal(revised.status, 0, revised.stderr);
    const revisedProject = JSON.parse(await readFile(projectPath, "utf8"));
    assert.equal(revisedProject.workflowStatus, "revision_in_progress");
    const revisedReview = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.equal(revisedReview.versions[0].evidenceStatus, "invalidated");
    assert.equal(revisedReview.versions[0].userStatus, "revision_requested");
    assert.equal(revisedReview.dependencyInvalidations.at(-1).planContentHash.length, 64);
    const archiveInput = path.join(tempRoot, "archive.json");
    await writeFile(archiveInput, `${JSON.stringify({ entries: [] }, null, 2)}\n`, "utf8");
    const archive = runCli(["archive", "--project", setup.projectDir, "--input", archiveInput]);
    assert.equal(archive.status, 1);
    assert.match(archive.stderr, /requires final_confirmed/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("review-recreation rolls back a pending application after Edit Plan write", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-pending-rollback-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const journalPath = path.join(setup.projectDir, "recreation-application.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.status = "pending";
    delete journal.editPlanAfterHash;
    delete journal.completedAt;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const planPath = path.join(setup.projectDir, "recreation-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.status = "approved";
    plan.applications = [];
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const revised = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(revised.status, 0, revised.stderr);
    const rolledBackJournal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(rolledBackJournal.status, "rolled_back");
    const editPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
    assert.equal(editPlan.referenceRecreationApplication, undefined);
    assert.equal(editPlan.shots.some((shot: any) => shot.referenceRecreation), false);
    const validated = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validated.status, 0, validated.stderr);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("pending recreation rollback is safe before Edit Plan write, resumable after rollback write, and closed on unknown state", async (context) => {
  for (const mode of ["before-write", "rollback-written", "unknown"] as const) {
    await context.test(mode, async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), `video-flow-reference-rollback-state-${mode}-`));
      try {
        const setup = await prepareApplication(tempRoot);
        const editPlanBefore = await readFile(setup.editPlanPath, "utf8");
        assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
        const journalPath = path.join(setup.projectDir, "recreation-application.json");
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        const appliedEditPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
        journal.status = "pending";
        delete journal.editPlanAfterHash;
        delete journal.completedAt;
        const planPath = path.join(setup.projectDir, "recreation-plan.json");
        const plan = JSON.parse(await readFile(planPath, "utf8"));
        plan.status = "approved";
        plan.applications = [];
        await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

        if (mode === "before-write") {
          await writeFile(setup.editPlanPath, editPlanBefore, "utf8");
        } else if (mode === "rollback-written") {
          for (const shot of appliedEditPlan.shots) delete shot.referenceRecreation;
          delete appliedEditPlan.referenceRecreationApplication;
          appliedEditPlan.referenceRecreationRevocation = {
            planContentHash: journal.planContentHash,
            reviewer: "王杰",
            authority: "user",
            notes: null,
            revokedAt: "2026-09-27T00:00:00.000Z",
          };
          journal.status = "rollback_pending";
          journal.rollbackEditPlanContentHash = sha256Canonical(appliedEditPlan);
          journal.rollbackStartedAt = "2026-09-27T00:00:00.000Z";
          journal.rollbackReviewer = "王杰";
          journal.rollbackAuthority = "user";
          journal.rollbackNotes = null;
          journal.rollbackRequestedAt = "2026-09-27T00:00:00.000Z";
          await writeFile(setup.editPlanPath, `${JSON.stringify(appliedEditPlan, null, 2)}\n`, "utf8");
        } else {
          appliedEditPlan.unrelatedUnknownMutation = true;
          await writeFile(setup.editPlanPath, `${JSON.stringify(appliedEditPlan, null, 2)}\n`, "utf8");
        }
        await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

        const revised = runCli([
          "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
        ]);
        if (mode === "unknown") {
          assert.equal(revised.status, 1);
          assert.match(revised.stderr, /unknown state/i);
          const unchangedPlan = JSON.parse(await readFile(planPath, "utf8"));
          assert.equal(unchangedPlan.status, "approved");
        } else {
          assert.equal(revised.status, 0, revised.stderr);
          const rolledBack = JSON.parse(await readFile(journalPath, "utf8"));
          assert.equal(rolledBack.status, "rolled_back");
          const validated = runCli(["validate", "--project", setup.projectDir]);
          assert.equal(validated.status, 0, validated.stderr);
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("a rolled-back Edit Plan can finish revoking an application after a cross-file interruption", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-rollback-finalize-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const editPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
    for (const shot of editPlan.shots) delete shot.referenceRecreation;
    delete editPlan.referenceRecreationApplication;
    await writeFile(setup.editPlanPath, `${JSON.stringify(editPlan, null, 2)}\n`, "utf8");

    const journalPath = path.join(setup.projectDir, "recreation-application.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.status = "rolled_back";
    journal.rollbackEditPlanContentHash = sha256Canonical(editPlan);
    journal.rolledBackBy = "王杰";
    journal.rolledBackAt = "2026-09-27T00:00:00.000Z";
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    const resumed = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const plan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(plan.status, "needs_revision");
    assert.equal(plan.applications.filter((record: any) => !record.revokedAt).length, 0);
    const validated = runCli(["validate", "--project", setup.projectDir]);
    assert.equal(validated.status, 0, validated.stderr);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a legacy completed journal can finish revocation after Edit Plan was already unbound", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-completed-revoke-recovery-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const journalPath = path.join(setup.projectDir, "recreation-application.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.status, "completed");
    const editPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
    for (const shot of editPlan.shots) delete shot.referenceRecreation;
    delete editPlan.referenceRecreationApplication;
    editPlan.referenceRecreationRevocation = {
      planContentHash: journal.planContentHash,
      reviewer: "王杰",
      authority: "user",
      notes: "模拟旧版本在 Edit Plan 写入后中断",
      revokedAt: "2026-09-27T00:00:00.000Z",
    };
    await writeFile(setup.editPlanPath, `${JSON.stringify(editPlan, null, 2)}\n`, "utf8");

    const resumed = runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const plan = JSON.parse(await readFile(path.join(setup.projectDir, "recreation-plan.json"), "utf8"));
    assert.equal(plan.status, "needs_revision");
    assert.equal(plan.applications.filter((record: any) => !record.revokedAt).length, 0);
    const recoveredJournal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(recoveredJournal.status, "rolled_back");
    assert.equal(runCli(["validate", "--project", setup.projectDir]).status, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("an applied recreation plan cannot be overwritten and revoked application history is preserved", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-overwrite-"));
  try {
    const setup = await prepareApplication(tempRoot);
    assert.equal(runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]).status, 0);
    const planPath = path.join(setup.projectDir, "recreation-plan.json");
    const before = await readFile(planPath, "utf8");
    const nextInput = path.join(tempRoot, "next-plan.json");
    await writeFile(nextInput, `${JSON.stringify(recreationInput(), null, 2)}\n`, "utf8");
    const overwritten = runCli(["plan-recreation", "--project", setup.projectDir, "--input", nextInput]);
    assert.equal(overwritten.status, 1);
    assert.match(overwritten.stderr, /cannot replace an applied plan/i);
    assert.equal(await readFile(planPath, "utf8"), before);

    assert.equal(runCli([
      "review-recreation", "--project", setup.projectDir, "--decision", "revise", "--reviewer", "王杰", "--authority", "user",
    ]).status, 0);
    const replanned = runCli(["plan-recreation", "--project", setup.projectDir, "--input", nextInput]);
    assert.equal(replanned.status, 0, replanned.stderr);
    const newPlan = JSON.parse(await readFile(planPath, "utf8"));
    assert.equal(newPlan.applications.length, 1);
    assert.equal(typeof newPlan.applications[0].revokedAt, "string");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("apply-recreation binds the approved target script to Transcript, Cut Plan, and Edit Plan speech", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-speech-bind-"));
  try {
    const setup = await prepareApplication(tempRoot);
    const editPlan = JSON.parse(await readFile(setup.editPlanPath, "utf8"));
    editPlan.shots[0].voiceover = "这是一段没有通过审批的其他口播";
    await writeFile(setup.editPlanPath, `${JSON.stringify(editPlan, null, 2)}\n`, "utf8");
    const mapping = JSON.parse(await readFile(setup.mappingPath, "utf8"));
    mapping.editPlanHash = await sha256Path(setup.editPlanPath);
    await writeFile(setup.mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    const applied = runCli(["apply-recreation", "--project", setup.projectDir, "--input", setup.mappingPath]);
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /does not bind the approved target script|voiceover does not match/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("reference transcript reconstruction preserves percentage and currency meaning", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "video-flow-reference-semantic-symbols-"));
  try {
    const setup = await setupReference(tempRoot);
    const invalid = referenceInput();
    invalid.referenceVerbatimTranscript.segments[0].text = "保费增长10%";
    invalid.referenceVerbatimTranscript.words[0].text = "保费";
    invalid.referenceVerbatimTranscript.words[1].text = "增长";
    invalid.referenceVerbatimTranscript.words[2].text = "10";
    await writeFile(setup.analysisInputPath, `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
    const result = runCli([
      "analyze-reference", "--project", setup.projectDir, "--asset-id", setup.assetId, "--input", setup.analysisInputPath,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /do not reconstruct transcript segment/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
