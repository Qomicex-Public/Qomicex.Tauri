using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.FeedTheBeast
{
    public class Modpacks : FTBBase
    {
        /// <summary>
        /// 搜索整合包（支持关键词、标签、MC版本、Modloader筛选与排序）
        /// </summary>
        /// <param name="query">搜索关键词（匹配名称与简介，可选）</param>
        /// <param name="tags">标签筛选列表（任意匹配，如 Tech, Magic）</param>
        /// <param name="mcVersion">Minecraft版本筛选（如 1.21.1）</param>
        /// <param name="loader">Modloader筛选（如 neoforge, forge）</param>
        /// <param name="sort">排序：featured / trending / name / plays / downloads / released / updated</param>
        /// <param name="limit">最大返回数量（默认20）</param>
        /// <returns>整合包列表</returns>
        public new async Task<List<FTBBase.ModpackInfo>> SearchAsync(
            string? query = null,
            List<string>? tags = null,
            string? mcVersion = null,
            string? loader = null,
            string sort = "featured",
            int limit = 20)
        {
            return await base.SearchAsync(query, tags, mcVersion, loader, sort, limit);
        }

        /// <summary>
        /// 获取全部整合包列表（带缓存，1小时内有效）
        /// </summary>
        /// <returns>全部整合包的基本信息列表</returns>
        public new async Task<List<FTBBase.ModpackInfo>> FetchAllPacksAsync()
        {
            return await base.FetchAllPacksAsync();
        }

        /// <summary>
        /// 从API获取整合包最新详情（含完整版本列表、标签、作者等）
        /// </summary>
        /// <param name="id">整合包ID</param>
        /// <returns>整合包详细信息，失败返回null</returns>
        public new async Task<FTBBase.ModpackInfo?> GetPackDetailAsync(int id)
        {
            return await base.GetPackDetailAsync(id);
        }

        /// <summary>
        /// 获取指定版本的文件列表及下载链接
        /// </summary>
        /// <param name="packId">整合包ID</param>
        /// <param name="versionId">版本ID</param>
        /// <returns>版本详情（含files数组），失败返回null</returns>
        public new async Task<FTBBase.VersionDetail?> GetVersionDetailAsync(int packId, int versionId)
        {
            return await base.GetVersionDetailAsync(packId, versionId);
        }

        /// <summary>
        /// 获取指定版本的更新日志
        /// </summary>
        /// <param name="packId">整合包ID</param>
        /// <param name="versionId">版本ID</param>
        /// <returns>更新日志（Markdown + HTML），失败返回null</returns>
        public new async Task<FTBBase.ChangelogResult?> GetChangelogAsync(int packId, int versionId)
        {
            return await base.GetChangelogAsync(packId, versionId);
        }

        /// <summary>
        /// 根据名称关键词在缓存中查找整合包
        /// </summary>
        /// <param name="nameOrId">名称关键词或ID</param>
        /// <returns>匹配的整合包，未找到返回null</returns>
        public async Task<FTBBase.ModpackInfo?> FindPackAsync(string nameOrId)
        {
            var all = await FetchAllPacksAsync();

            // 尝试按ID匹配
            if (int.TryParse(nameOrId, out var id))
            {
                var byId = all.FirstOrDefault(p => p.Id == id);
                if (byId != null) return byId;
            }

            // 按名称模糊匹配
            var q = nameOrId.ToLower();
            return all.FirstOrDefault(p =>
                p.Name.ToLower().Contains(q) ||
                (p.Slug?.ToLower().Contains(q) ?? false));
        }
    }
}
