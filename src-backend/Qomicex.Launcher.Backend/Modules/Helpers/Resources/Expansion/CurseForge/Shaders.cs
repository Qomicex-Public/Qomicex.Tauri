using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using static Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.CurseForge.CurseForgeBase;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class Shaders : CurseForgeBase
    {
        public Shaders(string ApiKey) : base(ApiKey, GetSearchUrl(), GetModUrl()) { }
        private static string GetSearchUrl()
        {
            return "/v1/mods/search?gameId=432&classId=6552";
        }

        private static string GetModUrl()
        {
            return "/v1/mods/";
        }

        /// <summary>
        /// 获取推荐的Shaders列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        public async Task<List<CurseForgeSearchResult>> GetRecommendShaders(string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.GetRecommend(GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的Shaders
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        public new async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.SearchAsync(SearchFilter, GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步获取指定Shaders的详细信息
        /// </summary>
        /// <param name="Id">ModId</param>
        /// <returns>Shaders信息</returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public async Task<CurseForgeInfo> GetModInfoAsync(string Id)
        {
            return await base.GetInfoAsync(Id);
        }

        public enum Category
        {
            Vanilla = 6555,
            Fantasy = 6554,
            Realistic = 6553,
        }
    }
}
