import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { databaseService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import {
	RESTORE_PHRASE,
	canRestore,
	describeCounts,
	describeImportResults,
	downloadPreRestoreBackup,
	escapeHtml,
	inspectBackupFile,
	restoreFromFile
} from './database-restore';

const DatabaseManagement = () => {
	const [stats, setStats] = useState(null);
	const [loading, setLoading] = useState(true);
	const [importing, setImporting] = useState(false);
	const [exporting, setExporting] = useState(false);

	// Restore: pick a file, save a copy of the current data, type the phrase.
	const [restoreFile, setRestoreFile] = useState(null);
	const [fileProblem, setFileProblem] = useState(null);
	const [fileCounts, setFileCounts] = useState(null);
	const [backupName, setBackupName] = useState(null);
	const [backingUp, setBackingUp] = useState(false);
	const [backupError, setBackupError] = useState(null);
	const [phrase, setPhrase] = useState('');
	const [restoring, setRestoring] = useState(false);

	// Fetch database stats
	useEffect(() => {
		fetchStats();
	}, []);

	const fetchStats = async () => {
		try {
			setLoading(true);
			const data = await databaseService.getDatabaseStats();
			setStats(data);
		} catch (error) {
			console.error('Error fetching database stats:', error);
			toast.error(error.message || 'Lỗi khi lấy thống kê database');
		} finally {
			setLoading(false);
		}
	};

	const handleExportDatabase = async () => {
		try {
			const result = await Swal.fire({
				title: 'Xuất dữ liệu nghiệp vụ?',
				html: `
					<div class="text-left">
						<p class="mb-3">Thao tác này sẽ xuất dữ liệu nghiệp vụ thành file JSON bao gồm:</p>
						<ul class="list-disc list-inside space-y-1 text-sm text-gray-600">
							<li>Sản phẩm (${stats?.collections?.products || 0} records)</li>
							<li>Đơn hàng, kèm lịch sử trạng thái, ghi chú và lịch sử sửa (${stats?.collections?.orders || 0} records)</li>
							<li>Combo (${stats?.collections?.combos || 0} records)</li>
							<li>Lịch sử tồn kho</li>
							<li>Cài đặt cửa hàng</li>
						</ul>
						<p class="mt-3 text-sm text-gray-600">
							<i class="fas fa-info-circle mr-1"></i>
							Không bao gồm người dùng/tài khoản đăng nhập vì lý do bảo mật; tài khoản không bị ảnh hưởng khi khôi phục. Ảnh sản phẩm chỉ được lưu dưới dạng đường dẫn.
						</p>
						<p class="mt-3 text-sm text-yellow-600">
							<i class="fas fa-exclamation-triangle mr-1"></i>
							Chỉ admin mới có quyền thực hiện thao tác này
						</p>
					</div>
				`,
				icon: 'question',
				showCancelButton: true,
				confirmButtonText: '<i class="fas fa-download mr-2"></i>Xuất Database',
				cancelButtonText: 'Hủy',
				confirmButtonColor: '#10b981',
				cancelButtonColor: '#6b7280'
			});

			if (result.isConfirmed) {
				setExporting(true);
				await databaseService.exportDatabase();
				toast.success('Database đã được xuất thành công!');
			}
		} catch (error) {
			console.error('Export error:', error);

			const errorMessage = error.response?.data?.message || error.message || 'Lỗi khi xuất database';
			// Server no longer reflects stack traces or source data back to the
			// client — only a correlation id, matched against server logs.
			const correlationId = error.response?.data?.correlationId;

			if (correlationId) {
				await Swal.fire({
					title: 'Lỗi Export!',
					html: `
						<div class="text-left">
							<p class="mb-4 text-red-600">${errorMessage}</p>
							<button id="download-export-error-btn" class="swal2-confirm swal2-styled bg-red-600 hover:bg-red-700">
								<i class="fas fa-download mr-2"></i>
								Tải chi tiết lỗi
							</button>
						</div>
					`,
					icon: 'error',
					confirmButtonText: 'Đóng',
					didOpen: () => {
						const downloadBtn = document.getElementById('download-export-error-btn');
						if (downloadBtn) {
							downloadBtn.addEventListener('click', () => {
								const errorText = `EXPORT DATABASE ERROR REPORT
Generated: ${new Date().toISOString()}

ERROR MESSAGE:
${errorMessage}

CORRELATION ID (tra trong server log):
${correlationId}
`;
								const blob = new Blob([errorText], { type: 'text/plain;charset=utf-8' });
								const url = URL.createObjectURL(blob);
								const link = document.createElement('a');
								link.href = url;
								link.download = `export-error-${new Date().toISOString().split('T')[0]}.txt`;
								link.click();
								URL.revokeObjectURL(url);
								toast.success('Đã tải file lỗi');
							});
						}
					}
				});
			} else {
				toast.error(errorMessage);
			}
		} finally {
			setExporting(false);
		}
	};

	const handleImportDatabase = () => {
		// Create file input element
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async (event) => {
			const file = event.target.files[0];
			if (!file) return;

			try {
				// Show confirmation dialog
				const result = await Swal.fire({
					title: 'Import Database?',
					html: `
						<div class="text-left">
							<p class="mb-3">Bạn đang chuẩn bị import dữ liệu từ file:</p>
							<div class="bg-gray-100 p-3 rounded mb-3">
								<p class="font-semibold">${file.name}</p>
								<p class="text-sm text-gray-600">Size: ${(file.size / 1024 / 1024).toFixed(2)} MB</p>
							</div>
							<div class="bg-yellow-50 border border-yellow-200 p-3 rounded mb-3">
								<p class="text-sm text-yellow-800">
									<i class="fas fa-exclamation-triangle mr-2"></i>
									<strong>Cảnh báo:</strong>
								</p>
								<ul class="list-disc list-inside text-sm text-yellow-700 mt-1">
									<li>Chỉ thêm bản ghi còn thiếu, bản ghi đã có được giữ nguyên và bỏ qua (không ghi đè)</li>
									<li>Không nạp lại lịch sử tồn kho và cài đặt. Muốn thay thế toàn bộ dữ liệu, dùng "Khôi phục"</li>
									<li>Quá trình này có thể mất vài phút</li>
									<li>Chỉ admin mới có quyền thực hiện</li>
								</ul>
							</div>
						</div>
					`,
					icon: 'warning',
					showCancelButton: true,
					confirmButtonText: '<i class="fas fa-upload mr-2"></i>Import',
					cancelButtonText: 'Hủy',
					confirmButtonColor: '#3b82f6',
					cancelButtonColor: '#6b7280'
				});

				if (result.isConfirmed) {
					setImporting(true);

					// Show progress toast
					const progressToast = toast.info('Đang import database...', {
						autoClose: false,
						closeButton: false
					});

					const response = await databaseService.importDatabase(file);

					// Close progress toast
					toast.dismiss(progressToast);

					// Show detailed results
					const totalImported = Object.values(response.results).reduce((sum, result) => sum + result.imported, 0);
					const totalSkipped = Object.values(response.results).reduce((sum, result) => sum + result.skipped, 0);
					const totalErrors = Object.values(response.results).reduce((sum, result) => sum + result.errors, 0);

					const summary = describeImportResults(response);

					const downloadErrorButton = totalErrors > 0 ?
						'<button id="download-error-btn" class="swal2-confirm swal2-styled mt-4 bg-red-600 hover:bg-red-700">Tải lỗi xuống</button>' : '';

					await Swal.fire({
						title: 'Import hoàn thành!',
						html: `
							<div class="text-left">
								<div class="grid grid-cols-3 gap-4 mb-4">
									<div class="text-center">
										<div class="text-2xl font-bold text-green-600">${totalImported}</div>
										<div class="text-sm text-gray-600">Imported</div>
									</div>
									<div class="text-center">
										<div class="text-2xl font-bold text-yellow-600">${totalSkipped}</div>
										<div class="text-sm text-gray-600">Skipped</div>
									</div>
									<div class="text-center">
										<div class="text-2xl font-bold text-red-600">${totalErrors}</div>
										<div class="text-sm text-gray-600">Errors</div>
									</div>
								</div>
								<div class="space-y-2 text-sm">
									${summary.lines.map((line) =>
							`<div class="flex justify-between gap-4">
											<span class="capitalize">${escapeHtml(line.collection)}:</span>
											<span class="text-right"><span class="text-green-600">+${line.imported}</span>${line.skippedText ? ` <span class="text-yellow-700">${escapeHtml(line.skippedText)}</span>` : ''}</span>
										</div>`
						).join('')}
								</div>
								${summary.ignored.length > 0 ? `<div class="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
									${summary.ignored.map(escapeHtml).join('<br/>')}
								</div>` : ''}
								${summary.dropped.length > 0 ? `<details class="mt-4 text-sm text-gray-600">
									<summary>Trường trong file không được nhập (số bản ghi)</summary>
									<div class="mt-1">${summary.dropped.map(escapeHtml).join('<br/>')}</div>
								</details>` : ''}
								${totalErrors > 0 ? `<div class="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
									<i class="fas fa-exclamation-triangle mr-2"></i>
									Có ${totalErrors} lỗi xảy ra. Nhấn nút bên dưới để tải file lỗi.
								</div>` : ''}
								${response.rejected ? `<div class="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800">
									<i class="fas fa-shield-alt mr-2"></i>
									${Object.entries(response.rejected).map(([section, info]) =>
										`${escapeHtml(section)}: ${info.count} bản ghi bị từ chối — ${escapeHtml(info.reason)}`
									).join('<br/>')}
								</div>` : ''}
								${downloadErrorButton}
							</div>
						`,
						icon: totalErrors > 0 ? 'warning' : 'success',
						confirmButtonText: 'OK',
						showConfirmButton: true,
						didOpen: () => {
							const downloadBtn = document.getElementById('download-error-btn');
							if (downloadBtn && response.errorDetails) {
								downloadBtn.addEventListener('click', () => {
									const errorText = generateErrorReport(response);
									const blob = new Blob([errorText], { type: 'text/plain;charset=utf-8' });
									const url = URL.createObjectURL(blob);
									const link = document.createElement('a');
									link.href = url;
									link.download = `import-errors-${new Date().toISOString().split('T')[0]}.txt`;
									link.click();
									URL.revokeObjectURL(url);
									toast.success('Đã tải file lỗi');
								});
							}
						}
					});

					// Refresh stats
					await fetchStats();
				}
			} catch (error) {
				console.error('Import error:', error);

				const errorMessage = error.response?.data?.message || error.message || 'Lỗi khi import database';
				// Server no longer reflects stack traces or source data back to the
				// client — only a correlation id, matched against server logs.
				const correlationId = error.response?.data?.correlationId;

				if (correlationId) {
					await Swal.fire({
						title: 'Lỗi Import!',
						html: `
							<div class="text-left">
								<p class="mb-4 text-red-600">${errorMessage}</p>
								<button id="download-critical-error-btn" class="swal2-confirm swal2-styled bg-red-600 hover:bg-red-700">
									<i class="fas fa-download mr-2"></i>
									Tải chi tiết lỗi
								</button>
							</div>
						`,
						icon: 'error',
						confirmButtonText: 'Đóng',
						didOpen: () => {
							const downloadBtn = document.getElementById('download-critical-error-btn');
							if (downloadBtn) {
								downloadBtn.addEventListener('click', () => {
									const errorText = `IMPORT DATABASE ERROR REPORT
Generated: ${new Date().toISOString()}

ERROR MESSAGE:
${errorMessage}

CORRELATION ID (tra trong server log):
${correlationId}
`;
									const blob = new Blob([errorText], { type: 'text/plain;charset=utf-8' });
									const url = URL.createObjectURL(blob);
									const link = document.createElement('a');
									link.href = url;
									link.download = `import-critical-error-${new Date().toISOString().split('T')[0]}.txt`;
									link.click();
									URL.revokeObjectURL(url);
									toast.success('Đã tải file lỗi');
								});
							}
						}
					});
				} else {
					toast.error(errorMessage);
				}
			} finally {
				setImporting(false);
			}
		};

		input.click();
	};

	const resetRestore = () => {
		setRestoreFile(null);
		setFileProblem(null);
		setFileCounts(null);
		setBackupName(null);
		setBackupError(null);
		setPhrase('');
	};

	// The safety copy is part of the restore: it is taken again for every chosen
	// file, and the restore stays locked until its download has started.
	const takeBackup = async () => {
		setBackingUp(true);
		setBackupError(null);
		setBackupName(null);
		try {
			setBackupName(await downloadPreRestoreBackup());
		} catch (error) {
			console.error('Pre-restore backup error:', error);
			setBackupError(error.message || 'Không tải được bản sao lưu hiện tại');
			toast.error(error.message || 'Không tải được bản sao lưu hiện tại');
		} finally {
			setBackingUp(false);
		}
	};

	const handleRestoreFileChange = async (event) => {
		const file = event.target.files[0];
		event.target.value = '';
		resetRestore();
		if (!file) return;

		setRestoreFile(file);
		const { problem, counts } = await inspectBackupFile(file);
		setFileProblem(problem);
		setFileCounts(counts);
		if (problem) {
			toast.error(problem);
			return;
		}
		await takeBackup();
	};

	const handleRestore = async () => {
		setRestoring(true);
		try {
			const response = await restoreFromFile(restoreFile, phrase);
			toast.success(`Đã khôi phục: ${describeCounts(response.restored)}`);
			resetRestore();
			await fetchStats();
		} catch (error) {
			console.error('Restore error:', error);
			if (error.problems && error.problems.length > 0) {
				await Swal.fire({
					title: 'Không khôi phục được',
					html: `
						<div class="text-left text-sm">
							<p class="mb-2 text-red-600">${escapeHtml(error.message)}</p>
							<ul class="list-disc list-inside text-gray-700">
								${error.problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}
							</ul>
						</div>
					`,
					icon: 'error',
					confirmButtonText: 'Đóng'
				});
			} else {
				toast.error(error.message || 'Lỗi khi khôi phục database');
			}
		} finally {
			setRestoring(false);
		}
	};

	const restoreReady = canRestore({
		file: restoreFile,
		fileProblem,
		backupSaved: Boolean(backupName),
		phrase,
		busy: backingUp || restoring
	});

	const generateErrorReport = (response) => {
		let report = `DATABASE IMPORT ERROR REPORT
Generated: ${new Date().toISOString()}

SUMMARY:
========
Total Imported: ${Object.values(response.results).reduce((sum, r) => sum + r.imported, 0)}
Total Skipped: ${Object.values(response.results).reduce((sum, r) => sum + r.skipped, 0)}
Total Errors: ${Object.values(response.results).reduce((sum, r) => sum + r.errors, 0)}

DETAILED ERRORS BY COLLECTION:
================================
`;

		if (response.errorDetails) {
			for (const [collection, errors] of Object.entries(response.errorDetails)) {
				if (errors && errors.length > 0) {
					report += `\n${collection.toUpperCase()} (${errors.length} errors):\n`;
					report += '-'.repeat(50) + '\n';

					errors.forEach((error, index) => {
						report += `\nError #${index + 1}:\n`;
						report += `  Index: ${error.index}\n`;
						report += `  Message: ${error.error}\n`;
						report += '\n';
					});
				}
			}
		}

		return report;
	};

	if (loading) {
		return (
			<div className="flex justify-center items-center h-64">
				<LoadingSpinner />
			</div>
		);
	}

	return (
		<div className="max-w-4xl mx-auto p-6">
			<div className="mb-8">
				<h1 className="text-3xl font-bold text-gray-900">Quản lý Database</h1>
				<p className="mt-2 text-gray-600">
					Xuất và nhập dữ liệu database. Chỉ dành cho quản trị viên.
				</p>
			</div>

			{/* Database Statistics */}
			<div className="bg-white rounded-lg shadow-md p-6 mb-8">
				<h2 className="text-xl font-semibold mb-4 flex items-center">
					<i className="fas fa-chart-bar mr-2 text-blue-500"></i>
					Thống kê Database
				</h2>

				{stats && (
					<div className="grid grid-cols-2 md:grid-cols-5 gap-4">
						<div className="bg-blue-50 p-4 rounded-lg">
							<div className="flex items-center">
								<i className="fas fa-users text-blue-500 text-xl mr-3"></i>
								<div>
									<p className="text-2xl font-bold text-blue-600">
										{stats.collections.users.toLocaleString()}
									</p>
									<p className="text-sm text-gray-600">Người dùng</p>
								</div>
							</div>
						</div>

						<div className="bg-green-50 p-4 rounded-lg">
							<div className="flex items-center">
								<i className="fas fa-box text-green-500 text-xl mr-3"></i>
								<div>
									<p className="text-2xl font-bold text-green-600">
										{stats.collections.products.toLocaleString()}
									</p>
									<p className="text-sm text-gray-600">Sản phẩm</p>
								</div>
							</div>
						</div>

						<div className="bg-yellow-50 p-4 rounded-lg">
							<div className="flex items-center">
								<i className="fas fa-shopping-cart text-yellow-500 text-xl mr-3"></i>
								<div>
									<p className="text-2xl font-bold text-yellow-600">
										{stats.collections.orders.toLocaleString()}
									</p>
									<p className="text-sm text-gray-600">Đơn hàng</p>
								</div>
							</div>
						</div>

						<div className="bg-indigo-50 p-4 rounded-lg">
							<div className="flex items-center">
								<i className="fas fa-layer-group text-indigo-500 text-xl mr-3"></i>
								<div>
									<p className="text-2xl font-bold text-indigo-600">
										{stats.collections.combos.toLocaleString()}
									</p>
									<p className="text-sm text-gray-600">Combo</p>
								</div>
							</div>
						</div>

						<div className="bg-purple-50 p-4 rounded-lg">
							<div className="flex items-center">
								<i className="fas fa-user-circle text-purple-500 text-xl mr-3"></i>
								<div>
									<p className="text-2xl font-bold text-purple-600">
										{stats.collections.accounts.toLocaleString()}
									</p>
									<p className="text-sm text-gray-600">Tài khoản</p>
								</div>
							</div>
						</div>
					</div>
				)}

				<div className="mt-4 text-sm text-gray-500">
					<i className="fas fa-clock mr-1"></i>
					Cập nhật lần cuối: {stats ? new Date(stats.lastUpdated).toLocaleString('vi-VN') : 'N/A'}
				</div>
			</div>

			{/* Database Operations */}
			<div className="bg-white rounded-lg shadow-md p-6">
				<h2 className="text-xl font-semibold mb-4 flex items-center">
					<i className="fas fa-database mr-2 text-gray-700"></i>
					Thao tác Database
				</h2>

				<div className="grid md:grid-cols-2 gap-6">
					{/* Export Database */}
					<div className="border border-gray-200 rounded-lg p-6">
						<div className="flex items-center mb-4">
							<div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mr-4">
								<i className="fas fa-download text-green-600 text-xl"></i>
							</div>
							<div>
								<h3 className="font-semibold text-gray-900">Xuất Database</h3>
								<p className="text-sm text-gray-600">Tải xuống toàn bộ dữ liệu</p>
							</div>
						</div>

						<p className="text-sm text-gray-600 mb-4">
							Xuất toàn bộ dữ liệu nghiệp vụ thành một file JSON: sản phẩm, combo, đơn hàng (kèm lịch sử), lịch sử tồn kho và cài đặt cửa hàng. Không bao gồm tài khoản đăng nhập. File này dùng được cho cả "Nhập Database" và "Khôi phục".
						</p>

						<button
							onClick={handleExportDatabase}
							disabled={exporting}
							className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 
								text-white font-medium py-2 px-4 rounded-lg transition-colors
								flex items-center justify-center"
						>
							{exporting ? (
								<>
									<LoadingSpinner size="small" className="mr-2" />
									Đang xuất...
								</>
							) : (
								<>
									<i className="fas fa-download mr-2"></i>
									Xuất Database
								</>
							)}
						</button>
					</div>

					{/* Import Database */}
					<div className="border border-gray-200 rounded-lg p-6">
						<div className="flex items-center mb-4">
							<div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mr-4">
								<i className="fas fa-upload text-blue-600 text-xl"></i>
							</div>
							<div>
								<h3 className="font-semibold text-gray-900">Nhập Database</h3>
								<p className="text-sm text-gray-600">Import dữ liệu từ file JSON</p>
							</div>
						</div>

						<p className="text-sm text-gray-600 mb-4">
							Gộp dữ liệu từ file JSON vào dữ liệu hiện có: chỉ thêm bản ghi còn thiếu, bản ghi đã tồn tại được giữ nguyên và bỏ qua, không bị ghi đè. Để thay thế toàn bộ dữ liệu bằng một bản sao lưu, dùng "Khôi phục" bên dưới.
						</p>

						<button
							onClick={handleImportDatabase}
							disabled={importing}
							className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 
								text-white font-medium py-2 px-4 rounded-lg transition-colors
								flex items-center justify-center"
						>
							{importing ? (
								<>
									<LoadingSpinner size="small" className="mr-2" />
									Đang nhập...
								</>
							) : (
								<>
									<i className="fas fa-upload mr-2"></i>
									Nhập Database
								</>
							)}
						</button>
					</div>
				</div>

				{/* Restore Database */}
				<div className="mt-6 border border-red-200 rounded-lg p-6">
					<div className="flex items-center mb-4">
						<div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center mr-4">
							<i className="fas fa-undo-alt text-red-600 text-xl"></i>
						</div>
						<div>
							<h3 className="font-semibold text-gray-900">Khôi phục từ bản sao lưu</h3>
							<p className="text-sm text-gray-600">Thay thế toàn bộ dữ liệu bằng file đã xuất</p>
						</div>
					</div>

					<p className="text-sm text-gray-700 mb-2">
						Thao tác này <strong>thay thế toàn bộ</strong> sản phẩm, combo, đơn hàng, lịch sử tồn kho và cài đặt hiện tại bằng nội dung trong file: giữ nguyên mã, lịch sử trạng thái, ghi chú, lịch sử sửa đơn và thời gian. Tài khoản đăng nhập không bị ảnh hưởng.
					</p>
					<p className="text-sm text-gray-700 mb-4">
						Hệ thống tự tải về một bản sao lưu dữ liệu hiện tại trước khi bạn xác nhận. Nếu có lỗi giữa chừng, không có dữ liệu nào bị thay đổi.
					</p>

					<ol className="space-y-4 text-sm">
						<li>
							<p className="font-medium text-gray-900 mb-2">Bước 1. Chọn file sao lưu (.json)</p>
							<input
								type="file"
								accept=".json,application/json"
								onChange={handleRestoreFileChange}
								disabled={backingUp || restoring}
								className="block w-full border border-gray-300 rounded-lg py-2 px-3 text-gray-700 disabled:bg-gray-100"
							/>
							{restoreFile && (
								<p className="mt-2 text-gray-600">
									{restoreFile.name} ({(restoreFile.size / 1024 / 1024).toFixed(2)} MB)
									{fileCounts && <> — chứa {describeCounts(fileCounts)}</>}
								</p>
							)}
							{fileProblem && <p className="mt-2 text-red-600">{fileProblem}</p>}
						</li>

						<li>
							<p className="font-medium text-gray-900 mb-2">Bước 2. Tải bản sao lưu dữ liệu hiện tại</p>
							<div className="flex items-center gap-3">
								{backingUp && (
									<span className="flex items-center text-gray-700">
										<LoadingSpinner size="small" className="mr-2" />
										Đang tải bản sao lưu hiện tại...
									</span>
								)}
								{!backingUp && backupName && (
									<span className="text-green-700">
										<i className="fas fa-check-circle mr-2"></i>
										Đã tải {backupName}
									</span>
								)}
								{!backingUp && !backupName && !restoreFile && <span className="text-gray-500">Chọn file ở bước 1 để bắt đầu.</span>}
								{!backingUp && backupError && (
									<>
										<span className="text-red-600">{backupError}</span>
										<button
											onClick={takeBackup}
											disabled={restoring}
											className="bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 text-white font-medium py-2 px-4 rounded-lg transition-colors"
										>
											Tải lại
										</button>
									</>
								)}
							</div>
						</li>

						<li>
							<p className="font-medium text-gray-900 mb-2">
								Bước 3. Gõ <code className="bg-gray-100 px-1 rounded">{RESTORE_PHRASE}</code> để xác nhận
							</p>
							<div className="flex items-center gap-3">
								<input
									type="text"
									value={phrase}
									onChange={(event) => setPhrase(event.target.value)}
									disabled={!backupName || restoring}
									autoComplete="off"
									placeholder={RESTORE_PHRASE}
									className="flex-1 border border-gray-300 rounded-lg py-2 px-3 disabled:bg-gray-100"
								/>
								<button
									onClick={handleRestore}
									disabled={!restoreReady}
									className="bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center"
								>
									{restoring ? (
										<>
											<LoadingSpinner size="small" className="mr-2" />
											Đang khôi phục...
										</>
									) : (
										<>
											<i className="fas fa-undo-alt mr-2"></i>
											Khôi phục
										</>
									)}
								</button>
							</div>
						</li>
					</ol>
				</div>

				{/* Security Notice */}
				<div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
					<div className="flex items-start">
						<i className="fas fa-shield-alt text-yellow-600 mt-1 mr-3"></i>
						<div>
							<h4 className="font-medium text-yellow-800 mb-1">Bảo mật</h4>
							<p className="text-sm text-yellow-700">
								Các thao tác này chỉ dành cho quản trị viên và được bảo vệ bởi Better-Auth.
								File import và file khôi phục được kiểm tra cấu trúc trước khi ghi; file sai định dạng bị từ chối toàn bộ, không ghi dữ liệu.
							</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export default DatabaseManagement;
