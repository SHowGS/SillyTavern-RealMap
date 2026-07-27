/**
 * 发送给位置推断LLM的四段提示词。
 *
 * 消息顺序固定为：
 * 1.system：DEFAULT_SYSTEM_PROMPT
 * 2.assistant：DEFAULT_ASSISTANT_REPLY
 * 3.user：CONTEXT_PROMPT_TEMPLATE渲染后的对话上下文
 * 4.assistant：DEFAULT_ASSISTANT_PREFILL
 *
 * 可以直接修改本文件中的四个常量来调整默认行为。
 */

export const DEFAULT_SYSTEM_PROMPT = `你是位置推断助手。你会读到一段角色扮演对话，其中包含上一轮用户与AI正文、上一轮确定的位置，以及本轮用户与AI正文。

你的任务是判断本轮结束时用户角色所处的地点，并以JSON输出。

规则：
- 仅依据正文描述判断，不脑补。
- 上一轮位置仅作参考，不直接沿用，除非本轮正文明确表示原地未动。
- 输出地点使用中文具体名称，例如“望京SOHO”或“故宫太和殿”，避免行政泛指。
- 无法确定时输出{"action":"null","reason":"..."}。
- 一律使用中文地点名。不要解释。只输出JSON。

输出格式：
{"action":"idle","place":"望京SOHO","poi":true}
{"action":"moving","from":"...","to":"...","route_mode":"walking","duration_min":30}
{"action":"null","reason":"叙事未含足够地理信息"}

route_mode可选值：walking/driving/riding/transfer`;

export const DEFAULT_ASSISTANT_REPLY = `好的。我会根据接下来提供的对话上下文判断本轮结束时用户角色的位置，并且只输出符合要求的JSON。`;

export const DEFAULT_ASSISTANT_PREFILL = `{`;

export const CONTEXT_PROMPT_TEMPLATE = `上一轮位置：{{previous_location}}

上一轮AI：
{{previous_ai}}

本轮用户：
{{current_user}}

本轮AI：
{{current_ai}}`;

export function renderContextPrompt({
    previousLocation = '无',
    previousAi = '无',
    currentUser = '无',
    currentAi = '无',
} = {}) {
    const values = {
        previous_location: previousLocation,
        previous_ai: previousAi,
        current_user: currentUser,
        current_ai: currentAi,
    };

    return CONTEXT_PROMPT_TEMPLATE.replace(
        /\{\{(previous_location|previous_ai|current_user|current_ai)\}\}/g,
        (_, key) => String(values[key] ?? '无'),
    );
}
