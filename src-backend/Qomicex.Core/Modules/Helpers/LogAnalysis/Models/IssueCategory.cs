namespace Qomicex.Core.Modules.Helpers.LogAnalysis.Models
{
    /// <summary>
    /// 问题分类枚举
    /// </summary>
    public enum IssueCategory
    {
        /// <summary>内存问题</summary>
        Memory,
        /// <summary>Mod冲突</summary>
        ModConflict,
        /// <summary>Java相关问题</summary>
        JavaRelated,
        /// <summary>资源问题</summary>
        Resource,
        /// <summary>性能问题</summary>
        Performance,
        /// <summary>未知问题</summary>
        Unknown
    }
}
