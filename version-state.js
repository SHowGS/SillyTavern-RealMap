export function formatVersionLabel({
    manifestVersion = '',
    branchName = '',
    commitHash = '',
} = {}) {
    const parts = [];
    if (manifestVersion) parts.push(`v${manifestVersion}`);
    if (branchName && commitHash) {
        parts.push(`${branchName}-${String(commitHash).slice(0, 7)}`);
    }
    return parts.join(' · ');
}

export function getUpdateButtonPresentation({ hasUpdate, canUpdate } = {}) {
    if (!hasUpdate) {
        return {
            available: false,
            current: true,
            disabled: true,
            text: '已是最新版',
            title: '当前已是最新版',
        };
    }
    if (!canUpdate) {
        return {
            available: true,
            current: false,
            disabled: true,
            text: '需要管理员',
            title: '全局扩展只能由管理员更新',
        };
    }
    return {
        available: true,
        current: false,
        disabled: false,
        text: '更新',
        title: '发现新版本，点击更新',
    };
}
