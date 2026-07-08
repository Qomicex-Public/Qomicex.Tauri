namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Modrinth
{
    public abstract class ModrinthSourceBase : ModrinthBase, IModrinthSource
    {
        // 子类需指定具体项目类型（如 "mod"、"resourcepack"）
        protected new abstract string ProjectType { get; }

        // 统一实现搜索逻辑（仅差异点为 ProjectType）
        public async Task<SearchResult> SearchAsync(
            string searchFilter,
            string gameVersion,
            string[]? categories = null,
            string[]? loaders = null,
            string index = Index.Relevance,
            int page = 0,
            int pageSize = 20
        )
        {
            // 统一参数验证（替代子类重复的检查）
            if (string.IsNullOrEmpty(searchFilter))
                throw new ArgumentException("搜索关键词不能为空", nameof(searchFilter));
            if (string.IsNullOrEmpty(gameVersion))
                throw new ArgumentException("游戏版本不能为空", nameof(gameVersion));
            if (pageSize < 1 || pageSize > 100)
                throw new ArgumentOutOfRangeException(nameof(pageSize), "每页数量必须在1-100之间");

            // 调用父类的搜索方法，传入子类的 ProjectType
            return await base.SearchAsync(
                query: searchFilter,
                projectType: ProjectType,
                gameVersion: gameVersion,
                categories: categories,
                loaders: loaders,
                index: index,
                page: page,
                pageSize: pageSize
            );
        }

        // 统一实现获取项目详情
        public async Task<ProjectInfo> GetProjectInfoAsync(string projectId)
        {
            if (string.IsNullOrEmpty(projectId))
                throw new ArgumentException("项目ID不能为空", nameof(projectId));

            return await base.GetProjectAsync(projectId);
        }

        // 统一实现获取项目版本列表
        public async Task<List<ProjectVersionInfo>> GetProjectVersionInfoAsync(string projectId)
        {
            if (string.IsNullOrEmpty(projectId))
                throw new ArgumentException("项目ID不能为空", nameof(projectId));

            var versions = await base.GetProjectVersionsAsync(projectId);
            return versions.Select(v => new ProjectVersionInfo
            {
                Id = v.Id,
                ProjectId = v.ProjectId,
                Name = v.Name,
                VersionNumber = v.VersionNumber,
                GameVersionIds = v.GameVersions,
                Loaders = v.Loaders,
                PublishedAt = v.DatePublished
            }).ToList();
        }

        // 统一实现获取单个版本详情
        public async Task<VersionInfo> GetVersionInfoAsync(string versionId)
        {
            if (string.IsNullOrEmpty(versionId))
                throw new ArgumentException("版本ID不能为空", nameof(versionId));

            return await base.GetVersionAsync(versionId);
        }
    }
}
