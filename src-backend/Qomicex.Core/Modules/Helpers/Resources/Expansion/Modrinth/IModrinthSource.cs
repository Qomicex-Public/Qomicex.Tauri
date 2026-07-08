using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using static Qomicex.Core.Modules.Helpers.Resources.Expansion.Modrinth.ModrinthBase;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Modrinth
{
    public interface IModrinthSource
    {
        // 搜索项目
        Task<SearchResult> SearchAsync(
            string searchFilter,
            string gameVersion,
            string[]? categories = null,
            string[]? loaders = null,
            string index = ModrinthBase.Index.Relevance,
            int page = 0,
            int pageSize = 20
        );

        // 获取项目详情
        Task<ProjectInfo> GetProjectInfoAsync(string projectId);

        // 获取项目版本列表
        Task<List<ProjectVersionInfo>> GetProjectVersionInfoAsync(string projectId);

        // 获取单个版本详情
        Task<VersionInfo> GetVersionInfoAsync(string versionId);
    }
}
